import { randomUUID } from 'node:crypto';
import { SettleLossUseCase } from '../../src/application/use-cases/wager/settle-loss.use-case';
import {
  IdempotencyPayloadConflictForLossError,
  InvalidSettleLossInputError,
  WalletCurrencyMismatchForLossError,
  WalletPlayerMismatchForLossError,
} from '../../src/application/use-cases/wager/settle-loss.errors';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/unit-of-work/unit-of-work';
import { Money } from '../../src/domain/money/money';
import type { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../src/domain/outbox/outbox-message.repository';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import type { WalletRepository } from '../../src/domain/wallet/wallet.repository';
import type { WagerTransaction } from '../../src/domain/wager-transaction/wager-transaction.entity';
import type { WagerTransactionRepository } from '../../src/domain/wager-transaction/wager-transaction.repository';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger/wallet-ledger-entry.entity';
import type { WalletLedgerEntryRepository } from '../../src/domain/wallet-ledger/wallet-ledger-entry.repository';

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
}

class FakeUow implements UnitOfWork {
  constructor(readonly repos: TransactionalRepositories) {}
  async run<T>(
    work: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    return work(this.repos);
  }
}

function buildInput(
  wallet: Wallet,
  overrides: Partial<Parameters<SettleLossUseCase['execute']>[0]> = {},
) {
  return {
    providerId: 'provider-a',
    playerId: wallet.playerId,
    walletId: wallet.id,
    amount: '0.00',
    currency: wallet.currency,
    roundId: 'round-1',
    gameId: 'game-1',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

describe('SettleLossUseCase', () => {
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
    });
    return {
      wallet,
      wallets,
      txs,
      ledger,
      outbox,
      useCase: new SettleLossUseCase(uow),
    };
  }

  it('PROCESSSED amount 0, sem ledger, um evento, version inalterada', async () => {
    const ctx = setup('80.00');
    const versionBefore = ctx.wallet.version;
    const result = await ctx.useCase.execute(buildInput(ctx.wallet));

    expect(result.status).toBe('PROCESSED');
    expect(result.amount).toBe('0.00');
    expect(result.observedBalance).toBe('80.00');
    expect(result.walletVersion).toBe(versionBefore);
    expect(ctx.wallets.wallet!.balance.toString()).toBe('80.00');
    expect(ctx.wallets.wallet!.version).toBe(versionBefore);
    expect(ctx.txs.items[0].kind).toBe('LOSS');
    expect(ctx.ledger.items).toHaveLength(0);
    expect(ctx.outbox.items.map((m) => m.eventType)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });

  it('replay idempotente sem efeitos extras', async () => {
    const ctx = setup('50.00');
    const input = buildInput(ctx.wallet);
    const first = await ctx.useCase.execute(input);
    const second = await ctx.useCase.execute(input);

    expect(second).toEqual(first);
    expect(ctx.txs.items).toHaveLength(1);
    expect(ctx.ledger.items).toHaveLength(0);
  });

  it('mesma key com payload diferente gera conflito', async () => {
    const ctx = setup();
    const key = randomUUID();
    await ctx.useCase.execute(
      buildInput(ctx.wallet, { idempotencyKey: key, roundId: 'r1' }),
    );

    await expect(
      ctx.useCase.execute(
        buildInput(ctx.wallet, {
          idempotencyKey: key,
          roundId: 'r2',
          externalTransactionId: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictForLossError);
  });

  it('rejeita amount não zero', async () => {
    const ctx = setup();
    await expect(
      ctx.useCase.execute(buildInput(ctx.wallet, { amount: '1.00' })),
    ).rejects.toBeInstanceOf(InvalidSettleLossInputError);
  });

  it('rejeita moeda incorreta', async () => {
    const ctx = setup();
    await expect(
      ctx.useCase.execute(buildInput(ctx.wallet, { currency: 'USD' })),
    ).rejects.toBeInstanceOf(WalletCurrencyMismatchForLossError);
  });

  it('rejeita player incorreto', async () => {
    const ctx = setup();
    await expect(
      ctx.useCase.execute(buildInput(ctx.wallet, { playerId: randomUUID() })),
    ).rejects.toBeInstanceOf(WalletPlayerMismatchForLossError);
  });
});
