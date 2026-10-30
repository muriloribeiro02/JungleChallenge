import { randomUUID } from 'node:crypto';
import type { MetricsPort } from '../../src/application/ports/metrics';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { SubmitWagerTransactionUseCase } from '../../src/application/use-cases/wager/submit-wager-transaction.use-case';
import { UnsupportedWagerKindError } from '../../src/application/use-cases/wager/submit-wager-transaction.errors';
import {
  ExternalTransactionIdConflictError,
  ReferenceAlreadyReversedConflictError,
} from '../../src/domain/wager-transaction/wager-transaction.errors';
import { FAILURE_CODE_REFERENCE_ALREADY_REVERSED } from '../../src/domain/wager-transaction/wager-transaction.entity';

class EmptyUow implements UnitOfWork {
  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>) {
    return work({
      wallets: {} as never,
      wagerTransactions: {
        findByProviderIdAndIdempotencyKey: async () => null,
      } as never,
      ledgerEntries: {} as never,
      outboxMessages: {} as never,
      inboxMessages: {} as never,
    });
  }
}

function baseInput(
  overrides: Partial<{
    kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
    referenceExternalTransactionId: string;
  }> = {},
) {
  return {
    providerId: 'p',
    externalTransactionId: randomUUID(),
    playerId: randomUUID(),
    walletId: randomUUID(),
    roundId: 'r',
    gameId: 'g',
    kind: 'BET' as const,
    money: { amount: '10.00', currency: 'BRL' },
    idempotencyKey: `p:${randomUUID()}`,
    ...overrides,
  };
}

describe('SubmitWagerTransactionUseCase (unit)', () => {
  it('rejeita kind inválido', async () => {
    const uc = new SubmitWagerTransactionUseCase(
      new EmptyUow(),
      { execute: async () => ({}) } as never,
      { execute: async () => ({}) } as never,
      { execute: async () => ({}) } as never,
      { execute: async () => ({}) } as never,
      { execute: async () => ({}) } as never,
    );

    await expect(
      uc.execute({
        ...baseInput(),
        kind: 'OPENING' as never,
      }),
    ).rejects.toBeInstanceOf(UnsupportedWagerKindError);
  });

  it('delega BET e marca idempotentReplay=false na primeira vez', async () => {
    const placeBet = {
      executeWithRepos: jest.fn(async () => ({
        transactionId: randomUUID(),
        status: 'PROCESSED',
        observedBalance: '90.00',
        currency: 'BRL',
      })),
    };
    const uc = new SubmitWagerTransactionUseCase(
      new EmptyUow(),
      placeBet as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
    );

    const result = await uc.execute(baseInput({ kind: 'BET' }));

    expect(placeBet.executeWithRepos).toHaveBeenCalled();
    expect(result.idempotentReplay).toBe(false);
    expect(result.balance?.amount).toBe('90.00');
  });

  it('REFUND: ReferenceAlreadyReversed → recover em nova UoW → REJECTED 200-path', async () => {
    const rejectedId = randomUUID();
    const refundWager = {
      executeWithRepos: jest
        .fn()
        .mockRejectedValue(new ReferenceAlreadyReversedConflictError()),
      recoverAfterReferenceAlreadyReversed: jest.fn(async () => ({
        transactionId: rejectedId,
        walletId: randomUUID(),
        status: 'REJECTED',
        failureCode: FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
        amount: '10.00',
        currency: 'BRL',
        observedBalance: '100.00',
        walletVersion: 2,
      })),
    };
    const metrics: MetricsPort = {
      ...({} as MetricsPort),
      recordWagerTransaction: jest.fn(),
      recordLockConflict: jest.fn(),
    };

    const uc = new SubmitWagerTransactionUseCase(
      new EmptyUow(),
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      refundWager as never,
      { executeWithRepos: async () => ({}) } as never,
      metrics,
    );

    const result = await uc.execute(
      baseInput({
        kind: 'REFUND',
        referenceExternalTransactionId: randomUUID(),
      }),
    );

    expect(refundWager.executeWithRepos).toHaveBeenCalled();
    expect(refundWager.recoverAfterReferenceAlreadyReversed).toHaveBeenCalledTimes(
      1,
    );
    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
    expect(result.transactionId).toBe(rejectedId);
    expect(result.idempotentReplay).toBe(false);
    expect(metrics.recordLockConflict).toHaveBeenCalledWith('reference_reversed');
    expect(metrics.recordWagerTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'REFUND',
        status: 'REJECTED',
        idempotentReplay: false,
      }),
    );
  });

  it('ROLLBACK: ReferenceAlreadyReversed → recover → REJECTED', async () => {
    const rollbackWager = {
      executeWithRepos: jest
        .fn()
        .mockRejectedValue(new ReferenceAlreadyReversedConflictError()),
      recoverAfterReferenceAlreadyReversed: jest.fn(async () => ({
        transactionId: randomUUID(),
        walletId: randomUUID(),
        status: 'REJECTED',
        failureCode: FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
        amount: '10.00',
        currency: 'BRL',
        observedBalance: '100.00',
      })),
    };

    const uc = new SubmitWagerTransactionUseCase(
      new EmptyUow(),
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      rollbackWager as never,
    );

    const result = await uc.execute(
      baseInput({
        kind: 'ROLLBACK',
        referenceExternalTransactionId: randomUUID(),
      }),
    );

    expect(rollbackWager.recoverAfterReferenceAlreadyReversed).toHaveBeenCalled();
    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
  });

  it('ExternalTransactionIdConflict continua propagado (não vira REJECTED)', async () => {
    const refundWager = {
      executeWithRepos: jest
        .fn()
        .mockRejectedValue(new ExternalTransactionIdConflictError()),
      recoverAfterReferenceAlreadyReversed: jest.fn(),
    };
    const uc = new SubmitWagerTransactionUseCase(
      new EmptyUow(),
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      refundWager as never,
      { executeWithRepos: async () => ({}) } as never,
    );

    await expect(
      uc.execute(
        baseInput({
          kind: 'REFUND',
          referenceExternalTransactionId: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(ExternalTransactionIdConflictError);
    expect(refundWager.recoverAfterReferenceAlreadyReversed).not.toHaveBeenCalled();
  });

  it('replay: key já REJECTED não chama recover (executeWithRepos devolve snapshot)', async () => {
    const txId = randomUUID();
    const refundWager = {
      executeWithRepos: jest.fn(async () => ({
        transactionId: txId,
        status: 'REJECTED',
        failureCode: FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
        observedBalance: '100.00',
        currency: 'BRL',
      })),
      recoverAfterReferenceAlreadyReversed: jest.fn(),
    };
    const uow: UnitOfWork = {
      run: async (work) =>
        work({
          wallets: {} as never,
          wagerTransactions: {
            findByProviderIdAndIdempotencyKey: async () =>
              ({ id: txId } as never),
          } as never,
          ledgerEntries: {} as never,
          outboxMessages: {} as never,
          inboxMessages: {} as never,
        }),
    };

    const uc = new SubmitWagerTransactionUseCase(
      uow,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      refundWager as never,
      { executeWithRepos: async () => ({}) } as never,
    );

    const result = await uc.execute(
      baseInput({
        kind: 'REFUND',
        referenceExternalTransactionId: randomUUID(),
      }),
    );

    expect(result.idempotentReplay).toBe(true);
    expect(result.status).toBe('REJECTED');
    expect(refundWager.recoverAfterReferenceAlreadyReversed).not.toHaveBeenCalled();
  });
});
