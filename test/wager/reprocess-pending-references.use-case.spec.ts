import { randomUUID } from 'node:crypto';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/wager/reprocess-pending-references.use-case';
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
    const idx = this.items.findIndex((t) => t.id === tx.id);
    if (idx >= 0) {
      this.items[idx] = tx;
    } else {
      this.items.push(tx);
    }
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

describe('ReprocessPendingReferencesUseCase', () => {
  const providerId = 'provider-reprocess';

  function setup(balance = '80.00') {
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
      useCase: new ReprocessPendingReferencesUseCase(uow),
    };
  }

  function seedBet(
    txs: FakeTx,
    wallet: Wallet,
    overrides: { amount?: string; externalTransactionId?: string } = {},
  ) {
    const externalTransactionId =
      overrides.externalTransactionId ?? randomUUID();
    const amount = Money.from({
      amount: overrides.amount ?? '20.00',
      currency: 'BRL',
    });
    const bet = WagerTransaction.betProcessed({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount,
      providerId,
      externalTransactionId,
      idempotencyKey: randomUUID(),
      payloadHash: 'hash-bet',
      roundId: 'round-1',
      gameId: 'game-1',
      snapshot: {
        observedBalance: Money.from({ amount: '80.00', currency: 'BRL' }),
        observedWalletVersion: 2,
      },
    });
    txs.items.push(bet);
    return bet;
  }

  function seedPendingRefund(
    txs: FakeTx,
    wallet: Wallet,
    externalReference: string,
    amount = '20.00',
  ) {
    const pending = WagerTransaction.refundPendingReference({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: Money.from({ amount, currency: 'BRL' }),
      providerId,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      payloadHash: 'hash-refund-pending',
      roundId: 'round-1',
      gameId: 'game-1',
      externalReference,
    });
    txs.items.push(pending);
    return pending;
  }

  function seedPendingRollback(
    txs: FakeTx,
    wallet: Wallet,
    externalReference: string,
    amount = '20.00',
  ) {
    const pending = WagerTransaction.rollbackPendingReference({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: Money.from({ amount, currency: 'BRL' }),
      providerId,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      payloadHash: 'hash-rollback-pending',
      roundId: 'round-1',
      gameId: 'game-1',
      externalReference,
    });
    txs.items.push(pending);
    return pending;
  }

  it('reprocessa REFUND pendente após BET existir: CREDIT + eventos', async () => {
    const { wallet, txs, ledger, outbox, wallets, useCase } = setup('80.00');
    const bet = seedBet(txs, wallet);
    const pending = seedPendingRefund(
      txs,
      wallet,
      bet.externalTransactionId!,
    );

    const result = await useCase.execute({
      providerId,
      externalReference: bet.externalTransactionId!,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('PROCESSED');
    expect(result.results[0].observedBalance).toBe('100.00');
    expect(wallets.wallet?.balance.toString()).toBe('100.00');
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0].direction).toBe('CREDIT');
    expect(ledger.items[0].transactionId).toBe(pending.id);
    expect(outbox.items.map((m) => m.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(
      outbox.items.find((m) => m.eventType === 'WagerTransactionProcessed')
        ?.aggregateId,
    ).toBe(pending.id);
    expect(
      outbox.items.find((m) => m.eventType === 'WalletBalanceChanged')
        ?.aggregateId,
    ).toBe(wallet.id);
  });

  it('reprocessa ROLLBACK pendente de BET: CREDIT', async () => {
    const { wallet, txs, ledger, wallets, useCase } = setup('80.00');
    const bet = seedBet(txs, wallet);
    seedPendingRollback(txs, wallet, bet.externalTransactionId!);

    const result = await useCase.execute({
      providerId,
      externalReference: bet.externalTransactionId!,
    });

    expect(result.results[0].status).toBe('PROCESSED');
    expect(wallets.wallet?.balance.toString()).toBe('100.00');
    expect(ledger.items[0].direction).toBe('CREDIT');
  });

  it('rejeita pendência cuja referência viola regras (WIN para REFUND)', async () => {
    const { wallet, txs, ledger, wallets, useCase } = setup('100.00');
    const win = WagerTransaction.winProcessed({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: Money.from({ amount: '20.00', currency: 'BRL' }),
      providerId,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      payloadHash: 'hash-win',
      roundId: 'round-1',
      gameId: 'game-1',
      snapshot: {
        observedBalance: Money.from({ amount: '120.00', currency: 'BRL' }),
        observedWalletVersion: 2,
      },
    });
    txs.items.push(win);
    const pending = seedPendingRefund(
      txs,
      wallet,
      win.externalTransactionId!,
    );

    const result = await useCase.execute({
      providerId,
      externalReference: win.externalTransactionId!,
    });

    expect(result.results[0].status).toBe('REJECTED');
    expect(result.results[0].failureCode).toBe(
      FAILURE_CODE_INVALID_REFERENCE_TYPE,
    );
    expect(wallets.wallet?.balance.toString()).toBe('100.00');
    expect(ledger.items).toHaveLength(0);
    expect(txs.items.find((t) => t.id === pending.id)?.status).toBe('REJECTED');
  });

  it('duas pendências da mesma referência: primeira PROCESSED, segunda REJECTED', async () => {
    const { wallet, txs, ledger, wallets, useCase } = setup('80.00');
    const bet = seedBet(txs, wallet);
    const first = seedPendingRefund(txs, wallet, bet.externalTransactionId!);
    // Garante createdAt distinto (mesmo ms quebra o tie-break por id UUID)
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = seedPendingRefund(txs, wallet, bet.externalTransactionId!);

    const result = await useCase.execute({
      providerId,
      externalReference: bet.externalTransactionId!,
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0].transactionId).toBe(first.id);
    expect(result.results[0].status).toBe('PROCESSED');
    expect(result.results[1].transactionId).toBe(second.id);
    expect(result.results[1].status).toBe('REJECTED');
    expect(result.results[1].failureCode).toBe(
      FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
    );
    expect(wallets.wallet?.balance.toString()).toBe('100.00');
    expect(ledger.items).toHaveLength(1);
  });

  it('reprocessamento repetido de pendência já processada é idempotente (SKIPPED)', async () => {
    const { wallet, txs, ledger, outbox, useCase } = setup('80.00');
    const bet = seedBet(txs, wallet);
    seedPendingRefund(txs, wallet, bet.externalTransactionId!);

    await useCase.execute({
      providerId,
      externalReference: bet.externalTransactionId!,
    });
    const ledgerCount = ledger.items.length;
    const outboxCount = outbox.items.length;

    const again = await useCase.execute({
      providerId,
      externalReference: bet.externalTransactionId!,
    });

    expect(again.results).toHaveLength(0);
    expect(ledger.items).toHaveLength(ledgerCount);
    expect(outbox.items).toHaveLength(outboxCount);

    const byId = await useCase.reprocessOne(
      txs.items.find((t) => t.kind === 'REFUND')!.id,
    );
    expect(byId.status).toBe('SKIPPED_TERMINAL');
    expect(ledger.items).toHaveLength(ledgerCount);
  });

  it('referência ainda ausente mantém PENDING_REFERENCE (defer)', async () => {
    const { wallet, txs, ledger, wallets, useCase } = setup();
    const pending = seedPendingRefund(txs, wallet, randomUUID());

    const result = await useCase.execute({
      providerId,
      externalReference: pending.externalReference!,
    });

    expect(result.results[0].status).toBe('PENDING_REFERENCE');
    expect(wallets.wallet?.balance.toString()).toBe('80.00');
    expect(ledger.items).toHaveLength(0);
  });

  it('não processa pendências de outro provider', async () => {
    const { wallet, txs, ledger, useCase } = setup('80.00');
    const bet = seedBet(txs, wallet);
    const other = WagerTransaction.refundPendingReference({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: Money.from({ amount: '20.00', currency: 'BRL' }),
      providerId: 'other-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      payloadHash: 'hash',
      roundId: 'round-1',
      gameId: 'game-1',
      externalReference: bet.externalTransactionId!,
    });
    txs.items.push(other);

    const result = await useCase.execute({
      providerId,
      externalReference: bet.externalTransactionId!,
    });

    expect(result.results).toHaveLength(0);
    expect(other.status).toBe('PENDING_REFERENCE');
    expect(ledger.items).toHaveLength(0);
  });
});
