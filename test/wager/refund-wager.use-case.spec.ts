import { randomUUID } from 'node:crypto';
import { RefundWagerUseCase } from '../../src/application/use-cases/wager/refund-wager.use-case';
import {
  IdempotencyPayloadConflictForRefundError,
  InvalidRefundWagerInputError,
} from '../../src/application/use-cases/wager/refund-wager.errors';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/unit-of-work/unit-of-work';
import { Money } from '../../src/domain/money/money';
import type { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../src/domain/outbox/outbox-message.repository';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import type { WalletRepository } from '../../src/domain/wallet/wallet.repository';
import {
  FAILURE_CODE_INVALID_REFERENCE_TYPE,
  FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
  FAILURE_CODE_REFERENCE_AMOUNT_MISMATCH,
  FAILURE_CODE_REFERENCE_NOT_PROCESSED,
  FAILURE_CODE_REFERENCE_SCOPE_MISMATCH,
  WagerTransaction,
} from '../../src/domain/wager-transaction/wager-transaction.entity';
import type { WagerTransactionRepository } from '../../src/domain/wager-transaction/wager-transaction.repository';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger/wallet-ledger-entry.entity';
import type { WalletLedgerEntryRepository } from '../../src/domain/wallet-ledger/wallet-ledger-entry.repository';
import { FakeInboxRepository } from '../helpers/fake-inbox';

class FakeWallets implements WalletRepository {
  constructor(private current: Wallet | null) {}
  get wallet(): Wallet | null {
    return this.current;
  }
  async save(wallet: Wallet): Promise<void> {
    this.current = wallet;
  }
  async findById(id: string): Promise<Wallet | null> {
    return this.current?.id === id ? this.current : null;
  }
  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    return this.findById(id);
  }
  async findByPlayerIdAndCurrency(): Promise<Wallet | null> {
    return this.current;
  }
}

class FakeTx implements WagerTransactionRepository {
  items: WagerTransaction[] = [];
  async save(tx: WagerTransaction): Promise<void> {
    this.items.push(tx);
  }
  async findByProviderIdAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.items.find(
        (t) =>
          t.providerId === providerId && t.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }
  async findByProviderIdAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.items.find(
        (t) =>
          t.providerId === providerId &&
          t.externalTransactionId === externalTransactionId,
      ) ?? null
    );
  }
  async findProcessedReversalByProviderAndExternalReference(
    kind: 'REFUND' | 'ROLLBACK',
    providerId: string,
    externalReference: string,
  ): Promise<WagerTransaction | null> {
    return (
      this.items.find(
        (t) =>
          t.kind === kind &&
          t.status === 'PROCESSED' &&
          t.providerId === providerId &&
          t.externalReference === externalReference,
      ) ?? null
    );
  }
  async findPendingByProviderAndExternalReference(
    providerId: string,
    externalReference: string,
  ): Promise<WagerTransaction[]> {
    return this.items
      .filter(
        (t) =>
          t.status === 'PENDING_REFERENCE' &&
          t.providerId === providerId &&
          t.externalReference === externalReference,
      )
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
  }
  async findById(id: string): Promise<WagerTransaction | null> {
    return this.items.find((t) => t.id === id) ?? null;
  }
  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    return this.items.find((t) => t.id === id) ?? null;
  }
}

class FakeLedger implements WalletLedgerEntryRepository {
  items: WalletLedgerEntry[] = [];
  async save(entry: WalletLedgerEntry): Promise<void> {
    this.items.push(entry);
  }
}

class FakeOutbox implements OutboxMessageRepository {
  items: OutboxMessage[] = [];
  async save(message: OutboxMessage): Promise<void> {
    this.items.push(message);
  }
  async findByAggregateId(aggregateId: string): Promise<OutboxMessage[]> {
    return this.items.filter((m) => m.aggregateId === aggregateId);
  }
  async findById(): Promise<OutboxMessage | null> {
    return null;
  }
  async claimUnpublished(): Promise<OutboxMessage[]> {
    return [];
  }
  async markPublished(): Promise<void> {}
  async markPublishFailed(): Promise<void> {}
}

class FakeUow implements UnitOfWork {
  constructor(readonly repos: TransactionalRepositories) {}
  async run<T>(
    work: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    return work(this.repos);
  }
}

describe('RefundWagerUseCase', () => {
  const providerId = 'provider-refund';

  function setup(balance = '50.00') {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
    });
    const wallets = new FakeWallets(wallet);
    const txs = new FakeTx();
    const ledger = new FakeLedger();
    const outbox = new FakeOutbox();
    const uow = new FakeUow({
      wallets,
      wagerTransactions: txs,
      ledgerEntries: ledger,
      outboxMessages: outbox,
      inboxMessages: new FakeInboxRepository(),
    });
    return {
      wallet,
      wallets,
      txs,
      ledger,
      outbox,
      useCase: new RefundWagerUseCase(uow),
    };
  }

  function seedBet(
    txs: FakeTx,
    wallet: Wallet,
    overrides: Partial<{
      externalTransactionId: string;
      amount: string;
      roundId: string;
      status: 'PROCESSED' | 'REJECTED';
      kind: 'BET' | 'WIN';
    }> = {},
  ) {
    const externalTransactionId =
      overrides.externalTransactionId ?? randomUUID();
    const amount = Money.from({
      amount: overrides.amount ?? '20.00',
      currency: 'BRL',
    });
    const snapshot = {
      observedBalance: Money.from({ amount: '80.00', currency: 'BRL' }),
      observedWalletVersion: 2,
    };
    const bet =
      (overrides.kind ?? 'BET') === 'WIN'
        ? WagerTransaction.winProcessed({
            id: randomUUID(),
            walletId: wallet.id,
            playerId: wallet.playerId,
            amount,
            providerId,
            externalTransactionId,
            idempotencyKey: randomUUID(),
            payloadHash: 'hash-win',
            roundId: overrides.roundId ?? 'round-1',
            gameId: 'game-1',
            snapshot,
          })
        : overrides.status === 'REJECTED'
          ? WagerTransaction.betRejectedInsufficientFunds({
              id: randomUUID(),
              walletId: wallet.id,
              playerId: wallet.playerId,
              amount,
              providerId,
              externalTransactionId,
              idempotencyKey: randomUUID(),
              payloadHash: 'hash-bet',
              roundId: overrides.roundId ?? 'round-1',
              gameId: 'game-1',
              snapshot: {
                observedBalance: wallet.balance,
                observedWalletVersion: wallet.version,
              },
            })
          : WagerTransaction.betProcessed({
              id: randomUUID(),
              walletId: wallet.id,
              playerId: wallet.playerId,
              amount,
              providerId,
              externalTransactionId,
              idempotencyKey: randomUUID(),
              payloadHash: 'hash-bet',
              roundId: overrides.roundId ?? 'round-1',
              gameId: 'game-1',
              snapshot,
            });
    txs.items.push(bet);
    return bet;
  }

  function input(
    wallet: Wallet,
    referenceExternalTransactionId: string,
    overrides: Record<string, string> = {},
  ) {
    return {
      providerId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      amount: '20.00',
      currency: 'BRL',
      roundId: 'round-1',
      gameId: 'game-1',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId,
      ...overrides,
    };
  }

  it('credita REFUND de BET válida e cria ledger CREDIT', async () => {
    const { wallet, txs, ledger, outbox, useCase, wallets } = setup('50.00');
    const bet = seedBet(txs, wallet);

    const result = await useCase.execute(
      input(wallet, bet.externalTransactionId!),
    );

    expect(result.status).toBe('PROCESSED');
    expect(result.observedBalance).toBe('70.00');
    expect(wallets.wallet?.balance.toString()).toBe('70.00');
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0].direction).toBe('CREDIT');
    expect(outbox.items.map((m) => m.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('rejeita REFUND de WIN (INVALID_REFERENCE_TYPE)', async () => {
    const { wallet, txs, ledger, useCase, wallets } = setup('50.00');
    const win = seedBet(txs, wallet, { kind: 'WIN' });

    const result = await useCase.execute(
      input(wallet, win.externalTransactionId!),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FAILURE_CODE_INVALID_REFERENCE_TYPE);
    expect(wallets.wallet?.balance.toString()).toBe('50.00');
    expect(ledger.items).toHaveLength(0);
  });

  it('rejeita escopo divergente', async () => {
    const { wallet, txs, useCase } = setup();
    const bet = seedBet(txs, wallet, { roundId: 'other-round' });

    const result = await useCase.execute(
      input(wallet, bet.externalTransactionId!),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FAILURE_CODE_REFERENCE_SCOPE_MISMATCH);
  });

  it('rejeita amount diferente', async () => {
    const { wallet, txs, useCase } = setup();
    const bet = seedBet(txs, wallet, { amount: '15.00' });

    const result = await useCase.execute(
      input(wallet, bet.externalTransactionId!),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FAILURE_CODE_REFERENCE_AMOUNT_MISMATCH);
  });

  it('rejeita referência não processada', async () => {
    const { wallet, txs, useCase } = setup();
    const bet = seedBet(txs, wallet, { status: 'REJECTED' });

    const result = await useCase.execute(
      input(wallet, bet.externalTransactionId!),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FAILURE_CODE_REFERENCE_NOT_PROCESSED);
  });

  it('rejeita REFUND duplicado da mesma referência', async () => {
    const { wallet, txs, useCase } = setup();
    const bet = seedBet(txs, wallet);

    await useCase.execute(input(wallet, bet.externalTransactionId!));
    const second = await useCase.execute(
      input(wallet, bet.externalTransactionId!),
    );

    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
  });

  it('persiste PENDING_REFERENCE sem alterar saldo nem ledger', async () => {
    const { wallet, ledger, outbox, useCase, wallets } = setup();

    const result = await useCase.execute(input(wallet, randomUUID()));

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(result.observedBalance).toBeUndefined();
    expect(wallets.wallet?.balance.toString()).toBe('50.00');
    expect(ledger.items).toHaveLength(0);
    expect(outbox.items.map((m) => m.eventType)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  it('replay idempotente preserva snapshot', async () => {
    const { wallet, txs, useCase } = setup();
    const bet = seedBet(txs, wallet);
    const payload = input(wallet, bet.externalTransactionId!);

    const first = await useCase.execute(payload);
    const second = await useCase.execute(payload);

    expect(second.transactionId).toBe(first.transactionId);
    expect(second.observedBalance).toBe(first.observedBalance);
    expect(second.walletVersion).toBe(first.walletVersion);
  });

  it('conflito de payload na mesma idempotency key', async () => {
    const { wallet, txs, useCase } = setup();
    const bet = seedBet(txs, wallet);
    const key = randomUUID();

    await useCase.execute(
      input(wallet, bet.externalTransactionId!, { idempotencyKey: key }),
    );

    await expect(
      useCase.execute(
        input(wallet, bet.externalTransactionId!, {
          idempotencyKey: key,
          amount: '21.00',
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictForRefundError);
  });

  it('exige referenceExternalTransactionId', async () => {
    const { wallet, useCase } = setup();

    await expect(
      useCase.execute(
        input(wallet, 'x', { referenceExternalTransactionId: '  ' }),
      ),
    ).rejects.toBeInstanceOf(InvalidRefundWagerInputError);
  });
});
