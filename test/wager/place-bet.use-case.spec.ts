import { randomUUID } from 'node:crypto';
import { PlaceBetUseCase } from '../../src/application/use-cases/wager/place-bet.use-case';
import {
  IdempotencyPayloadConflictError,
  InvalidPlaceBetInputError,
  TerminalTransactionSnapshotMissingError,
  WalletCurrencyMismatchForBetError,
  WalletPlayerMismatchError,
} from '../../src/application/use-cases/wager/place-bet.errors';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/unit-of-work/unit-of-work';
import { computeBetPayloadHash } from '../../src/application/wager/canonical-payload-hash';
import { Money } from '../../src/domain/money/money';
import type { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../src/domain/outbox/outbox-message.repository';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import type { WalletRepository } from '../../src/domain/wallet/wallet.repository';
import {
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_TYPE_BET,
  WagerTransaction,
} from '../../src/domain/wager-transaction/wager-transaction.entity';
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
  overrides: Partial<Parameters<PlaceBetUseCase['execute']>[0]> = {},
) {
  return {
    providerId: 'provider-a',
    playerId: wallet.playerId,
    walletId: wallet.id,
    amount: '40.00',
    currency: wallet.currency,
    roundId: 'round-1',
    gameId: 'game-1',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

describe('PlaceBetUseCase', () => {
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
      useCase: new PlaceBetUseCase(uow),
    };
  }

  it('aprova BET: debita, ledger DEBIT, version++, dois eventos e snapshot', async () => {
    const ctx = setup('100.00');
    const result = await ctx.useCase.execute(buildInput(ctx.wallet));

    expect(result.status).toBe('PROCESSED');
    expect(result.observedBalance).toBe('60.00');
    expect(result.walletVersion).toBe(2);
    expect(ctx.wallets.wallet!.version).toBe(2);
    expect(ctx.wallets.wallet!.balance.toString()).toBe('60.00');
    expect(ctx.txs.items).toHaveLength(1);
    expect(ctx.txs.items[0].status).toBe('PROCESSED');
    expect(ctx.txs.items[0].observedBalance?.toString()).toBe('60.00');
    expect(ctx.txs.items[0].observedWalletVersion).toBe(2);
    expect(ctx.ledger.items).toHaveLength(1);
    expect(ctx.ledger.items[0].direction).toBe('DEBIT');
    expect(ctx.outbox.items.map((m) => m.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('saldo insuficiente: REJECTED + evento rejected, sem ledger/débito', async () => {
    const ctx = setup('10.00');
    const versionBefore = ctx.wallet.version;

    const result = await ctx.useCase.execute(
      buildInput(ctx.wallet, { amount: '50.00' }),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.observedBalance).toBe('10.00');
    expect(result.walletVersion).toBe(versionBefore);
    expect(ctx.wallets.wallet!.version).toBe(versionBefore);
    expect(ctx.wallets.wallet!.balance.toString()).toBe('10.00');
    expect(ctx.txs.items[0].observedBalance?.toString()).toBe('10.00');
    expect(ctx.txs.items[0].observedWalletVersion).toBe(versionBefore);
    expect(ctx.ledger.items).toHaveLength(0);
    expect(ctx.outbox.items.map((m) => m.eventType)).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  it('rejeita moeda incorreta', async () => {
    const ctx = setup();
    await expect(
      ctx.useCase.execute(buildInput(ctx.wallet, { currency: 'USD' })),
    ).rejects.toBeInstanceOf(WalletCurrencyMismatchForBetError);
  });

  it('rejeita player incorreto', async () => {
    const ctx = setup();
    await expect(
      ctx.useCase.execute(buildInput(ctx.wallet, { playerId: randomUUID() })),
    ).rejects.toBeInstanceOf(WalletPlayerMismatchError);
  });

  it('replay idempotente retorna resultado original sem novo débito', async () => {
    const ctx = setup('100.00');
    const input = buildInput(ctx.wallet);
    const first = await ctx.useCase.execute(input);
    const second = await ctx.useCase.execute(input);

    expect(second).toEqual(first);
    expect(ctx.txs.items).toHaveLength(1);
    expect(ctx.ledger.items).toHaveLength(1);
    expect(ctx.wallets.wallet!.balance.toString()).toBe('60.00');
  });

  it('replay preserva observedBalance após saldo atual mudar', async () => {
    const ctx = setup('100.00');
    const input = buildInput(ctx.wallet, { amount: '40.00' });
    const first = await ctx.useCase.execute(input);

    await ctx.wallets.save(
      Wallet.rehydrate({
        id: ctx.wallet.id,
        playerId: ctx.wallet.playerId,
        currency: 'BRL',
        balance: { amount: '10.00', currency: 'BRL' },
        version: 99,
        createdAt: ctx.wallet.createdAt,
        updatedAt: new Date(),
      }),
    );

    const second = await ctx.useCase.execute(input);
    expect(second.observedBalance).toBe(first.observedBalance);
    expect(second.observedBalance).toBe('60.00');
    expect(second.walletVersion).toBe(first.walletVersion);
    expect(second.walletVersion).toBe(2);
    expect(ctx.wallets.wallet!.balance.toString()).toBe('10.00');
  });

  it('replay de terminal legado sem snapshot falha explicitamente', async () => {
    const ctx = setup('100.00');
    const input = buildInput(ctx.wallet, { amount: '10.00' });
    const payloadHash = computeBetPayloadHash({
      providerId: input.providerId,
      playerId: input.playerId,
      walletId: input.walletId,
      amount: '10.00',
      currency: 'BRL',
      roundId: input.roundId,
      gameId: input.gameId,
      externalTransactionId: input.externalTransactionId,
      kind: 'BET',
    });

    ctx.txs.items.push(
      WagerTransaction.rehydrate({
        id: randomUUID(),
        walletId: input.walletId,
        playerId: input.playerId,
        type: WAGER_TRANSACTION_TYPE_BET,
        status: WAGER_TRANSACTION_STATUS_PROCESSED,
        amount: { amount: '10.00', currency: 'BRL' },
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        roundId: input.roundId,
        gameId: input.gameId,
        failureCode: null,
      }),
    );

    await expect(ctx.useCase.execute(input)).rejects.toBeInstanceOf(
      TerminalTransactionSnapshotMissingError,
    );
  });

  it('mesma chave com payload diferente gera conflito', async () => {
    const ctx = setup('100.00');
    const key = randomUUID();
    await ctx.useCase.execute(
      buildInput(ctx.wallet, { idempotencyKey: key, amount: '10.00' }),
    );

    await expect(
      ctx.useCase.execute(
        buildInput(ctx.wallet, {
          idempotencyKey: key,
          amount: '20.00',
          externalTransactionId: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);
  });

  it('amount inválido (zero) é rejeitado', async () => {
    const ctx = setup();
    await expect(
      ctx.useCase.execute(buildInput(ctx.wallet, { amount: '0.00' })),
    ).rejects.toBeInstanceOf(InvalidPlaceBetInputError);
  });

  it('version incrementa somente no sucesso', async () => {
    const ok = setup('100.00');
    await ok.useCase.execute(buildInput(ok.wallet, { amount: '10.00' }));
    expect(ok.wallets.wallet!.version).toBe(2);

    const rejected = setup('5.00');
    const v0 = rejected.wallet.version;
    await rejected.useCase.execute(
      buildInput(rejected.wallet, { amount: '50.00' }),
    );
    expect(rejected.wallets.wallet!.version).toBe(v0);
  });

  it('hash canônico é estável independente da ordem das chaves no objeto fonte', () => {
    const a = computeBetPayloadHash({
      providerId: 'p',
      playerId: 'pl',
      walletId: 'w',
      amount: '1.00',
      currency: 'BRL',
      roundId: 'r',
      gameId: 'g',
      externalTransactionId: 'e',
      kind: 'BET',
    });
    const b = computeBetPayloadHash({
      kind: 'BET',
      externalTransactionId: 'e',
      gameId: 'g',
      roundId: 'r',
      currency: 'BRL',
      amount: '1.00',
      walletId: 'w',
      playerId: 'pl',
      providerId: 'p',
    });
    expect(a).toBe(b);
  });
});
