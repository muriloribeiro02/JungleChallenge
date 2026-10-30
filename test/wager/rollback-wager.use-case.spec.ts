import { randomUUID } from 'node:crypto';
import { RollbackWagerUseCase } from '../../src/application/use-cases/wager/rollback-wager.use-case';
import {
  IdempotencyPayloadConflictForRollbackError,
  InvalidRollbackWagerInputError,
} from '../../src/application/use-cases/wager/rollback-wager.errors';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { Money } from '../../src/domain/money/money';
import type { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../src/domain/outbox/outbox-message.repository';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import type { WalletRepository } from '../../src/domain/wallet/wallet.repository';
import {
  FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
  FAILURE_CODE_REFERENCE_AMOUNT_MISMATCH,
  FAILURE_CODE_REFERENCE_NOT_PROCESSED,
  FAILURE_CODE_REFERENCE_SCOPE_MISMATCH,
  FAILURE_CODE_REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
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

describe('RollbackWagerUseCase', () => {
  const providerId = 'provider-rollback';

  function setup(balance = '100.00') {
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
      useCase: new RollbackWagerUseCase(uow),
    };
  }

  function snapshot(balance: string, version: number) {
    return {
      observedBalance: Money.from({ amount: balance, currency: 'BRL' }),
      observedWalletVersion: version,
    };
  }

  function seedBet(txs: FakeTx, wallet: Wallet, amount = '20.00') {
    const externalTransactionId = randomUUID();
    const bet = WagerTransaction.betProcessed({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: Money.from({ amount, currency: 'BRL' }),
      providerId,
      externalTransactionId,
      idempotencyKey: randomUUID(),
      payloadHash: 'hash-bet',
      roundId: 'round-1',
      gameId: 'game-1',
      snapshot: snapshot('80.00', 2),
    });
    txs.items.push(bet);
    return bet;
  }

  function seedWin(txs: FakeTx, wallet: Wallet, amount = '30.00') {
    const externalTransactionId = randomUUID();
    const win = WagerTransaction.winProcessed({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: Money.from({ amount, currency: 'BRL' }),
      providerId,
      externalTransactionId,
      idempotencyKey: randomUUID(),
      payloadHash: 'hash-win',
      roundId: 'round-1',
      gameId: 'game-1',
      snapshot: snapshot('130.00', 2),
    });
    txs.items.push(win);
    return win;
  }

  function seedRefund(txs: FakeTx, wallet: Wallet, amount = '20.00') {
    const externalTransactionId = randomUUID();
    const refund = WagerTransaction.refundProcessed({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: Money.from({ amount, currency: 'BRL' }),
      providerId,
      externalTransactionId,
      idempotencyKey: randomUUID(),
      payloadHash: 'hash-refund',
      roundId: 'round-1',
      gameId: 'game-1',
      externalReference: randomUUID(),
      resolvedInternalReference: randomUUID(),
      snapshot: snapshot('100.00', 3),
    });
    txs.items.push(refund);
    return refund;
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

  it('ROLLBACK de BET credita e gera CREDIT', async () => {
    const { wallet, txs, ledger, useCase, wallets } = setup('80.00');
    const bet = seedBet(txs, wallet);

    const result = await useCase.execute(
      input(wallet, bet.externalTransactionId!),
    );

    expect(result.status).toBe('PROCESSED');
    expect(result.observedBalance).toBe('100.00');
    expect(wallets.wallet?.balance.toString()).toBe('100.00');
    expect(ledger.items[0].direction).toBe('CREDIT');
  });

  it('ROLLBACK de WIN debita e gera DEBIT', async () => {
    const { wallet, txs, ledger, useCase, wallets } = setup('130.00');
    const win = seedWin(txs, wallet, '30.00');

    const result = await useCase.execute(
      input(wallet, win.externalTransactionId!, { amount: '30.00' }),
    );

    expect(result.status).toBe('PROCESSED');
    expect(result.observedBalance).toBe('100.00');
    expect(wallets.wallet?.balance.toString()).toBe('100.00');
    expect(ledger.items[0].direction).toBe('DEBIT');
  });

  it('ROLLBACK de REFUND debita e gera DEBIT', async () => {
    const { wallet, txs, ledger, useCase, wallets } = setup('100.00');
    const refund = seedRefund(txs, wallet, '20.00');

    const result = await useCase.execute(
      input(wallet, refund.externalTransactionId!),
    );

    expect(result.status).toBe('PROCESSED');
    expect(result.observedBalance).toBe('80.00');
    expect(wallets.wallet?.balance.toString()).toBe('80.00');
    expect(ledger.items[0].direction).toBe('DEBIT');
  });

  it('rejeita escopo divergente', async () => {
    const { wallet, txs, useCase } = setup();
    const bet = seedBet(txs, wallet);

    const result = await useCase.execute(
      input(wallet, bet.externalTransactionId!, { roundId: 'other' }),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FAILURE_CODE_REFERENCE_SCOPE_MISMATCH);
  });

  it('rejeita amount diferente', async () => {
    const { wallet, txs, useCase } = setup();
    const bet = seedBet(txs, wallet, '20.00');

    const result = await useCase.execute(
      input(wallet, bet.externalTransactionId!, { amount: '19.00' }),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FAILURE_CODE_REFERENCE_AMOUNT_MISMATCH);
  });

  it('rejeita referência não processada', async () => {
    const { wallet, txs, useCase } = setup();
    const rejected = WagerTransaction.betRejectedInsufficientFunds({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: Money.from({ amount: '20.00', currency: 'BRL' }),
      providerId,
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      payloadHash: 'hash',
      roundId: 'round-1',
      gameId: 'game-1',
      snapshot: snapshot(wallet.balance.toString(), wallet.version),
    });
    txs.items.push(rejected);

    const result = await useCase.execute(
      input(wallet, rejected.externalTransactionId!),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FAILURE_CODE_REFERENCE_NOT_PROCESSED);
  });

  it('rejeita ROLLBACK duplicado', async () => {
    const { wallet, txs, useCase } = setup('80.00');
    const bet = seedBet(txs, wallet);

    await useCase.execute(input(wallet, bet.externalTransactionId!));
    const second = await useCase.execute(
      input(wallet, bet.externalTransactionId!),
    );

    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
  });

  it('rejeita débito que geraria saldo negativo', async () => {
    const { wallet, txs, ledger, useCase, wallets } = setup('10.00');
    const win = seedWin(txs, wallet, '30.00');

    const result = await useCase.execute(
      input(wallet, win.externalTransactionId!, { amount: '30.00' }),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(
      FAILURE_CODE_REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
    );
    expect(wallets.wallet?.balance.toString()).toBe('10.00');
    expect(ledger.items).toHaveLength(0);
  });

  it('PENDING_REFERENCE sem ledger nem alteração de saldo', async () => {
    const { wallet, ledger, outbox, useCase, wallets } = setup();

    const result = await useCase.execute(input(wallet, randomUUID()));

    expect(result.status).toBe('PENDING_REFERENCE');
    expect(wallets.wallet?.balance.toString()).toBe('100.00');
    expect(ledger.items).toHaveLength(0);
    expect(outbox.items[0].eventType).toBe(
      'WagerTransactionPendingReference',
    );
  });

  it('replay e conflito de payload', async () => {
    const { wallet, txs, useCase } = setup('80.00');
    const bet = seedBet(txs, wallet);
    const key = randomUUID();
    const payload = input(wallet, bet.externalTransactionId!, {
      idempotencyKey: key,
    });

    const first = await useCase.execute(payload);
    const second = await useCase.execute(payload);
    expect(second.transactionId).toBe(first.transactionId);

    await expect(
      useCase.execute({ ...payload, amount: '21.00' }),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictForRollbackError);
  });

  it('exige referenceExternalTransactionId', async () => {
    const { wallet, useCase } = setup();

    await expect(
      useCase.execute(
        input(wallet, 'x', { referenceExternalTransactionId: '' }),
      ),
    ).rejects.toBeInstanceOf(InvalidRollbackWagerInputError);
  });
});
