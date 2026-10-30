import { randomUUID } from 'node:crypto';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { SubmitWagerTransactionUseCase } from '../../src/application/use-cases/wager/submit-wager-transaction.use-case';
import { UnsupportedWagerKindError } from '../../src/application/use-cases/wager/submit-wager-transaction.errors';

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
        providerId: 'p',
        externalTransactionId: 'e',
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'r',
        gameId: 'g',
        kind: 'OPENING' as never,
        money: { amount: '1.00', currency: 'BRL' },
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(UnsupportedWagerKindError);
  });

  it('delega BET e marca idempotentReplay=false na primeira vez', async () => {
    const placeBet = {
      execute: jest.fn(async () => ({
        transactionId: randomUUID(),
        status: 'PROCESSED',
        observedBalance: '90.00',
        currency: 'BRL',
      })),
    };
    const uc = new SubmitWagerTransactionUseCase(
      new EmptyUow(),
      placeBet as never,
      { execute: async () => ({}) } as never,
      { execute: async () => ({}) } as never,
      { execute: async () => ({}) } as never,
      { execute: async () => ({}) } as never,
    );

    const result = await uc.execute({
      providerId: 'p',
      externalTransactionId: 'e',
      playerId: randomUUID(),
      walletId: randomUUID(),
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      idempotencyKey: 'p:e',
    });

    expect(placeBet.execute).toHaveBeenCalled();
    expect(result.idempotentReplay).toBe(false);
    expect(result.balance?.amount).toBe('90.00');
  });
});
