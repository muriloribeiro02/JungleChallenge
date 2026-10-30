import { randomUUID } from 'node:crypto';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { InvalidMoneyError } from '../../src/domain/money/money.errors';
import type { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../src/domain/outbox/outbox-message.repository';
import type { WagerTransaction } from '../../src/domain/wager-transaction/wager-transaction.entity';
import type { WagerTransactionRepository } from '../../src/domain/wager-transaction/wager-transaction.repository';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import { WalletAlreadyExistsError } from '../../src/domain/wallet/wallet.errors';
import type { WalletRepository } from '../../src/domain/wallet/wallet.repository';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger/wallet-ledger-entry.entity';
import type { WalletLedgerEntryRepository } from '../../src/domain/wallet-ledger/wallet-ledger-entry.repository';
import { FakeInboxRepository } from '../helpers/fake-inbox';

class InMemoryWalletRepository implements WalletRepository {
  readonly items = new Map<string, Wallet>();

  async save(wallet: Wallet): Promise<void> {
    for (const existing of this.items.values()) {
      if (
        existing.playerId === wallet.playerId &&
        existing.currency === wallet.currency &&
        existing.id !== wallet.id
      ) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
    }
    this.items.set(wallet.id, wallet);
  }

  async findById(id: string): Promise<Wallet | null> {
    return this.items.get(id) ?? null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    return this.findById(id);
  }

  async findByPlayerIdAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    for (const wallet of this.items.values()) {
      if (wallet.playerId === playerId && wallet.currency === currency) {
        return wallet;
      }
    }
    return null;
  }
}

class InMemoryWagerTransactionRepository
  implements WagerTransactionRepository
{
  readonly items: WagerTransaction[] = [];

  async save(transaction: WagerTransaction): Promise<void> {
    this.items.push(transaction);
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

class InMemoryLedgerRepository implements WalletLedgerEntryRepository {
  readonly items: WalletLedgerEntry[] = [];

  async save(entry: WalletLedgerEntry): Promise<void> {
    this.items.push(entry);
  }
}

class InMemoryOutboxRepository implements OutboxMessageRepository {
  readonly items: OutboxMessage[] = [];

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

class InMemoryUnitOfWork implements UnitOfWork {
  readonly wallets = new InMemoryWalletRepository();
  readonly wagerTransactions = new InMemoryWagerTransactionRepository();
  readonly ledgerEntries = new InMemoryLedgerRepository();
  readonly outboxMessages = new InMemoryOutboxRepository();
  readonly inboxMessages = new FakeInboxRepository();
  failAfterWalletSave = false;

  async run<T>(
    work: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = {
      wallets: new Map(this.wallets.items),
      txs: [...this.wagerTransactions.items],
      ledger: [...this.ledgerEntries.items],
      outbox: [...this.outboxMessages.items],
      inbox: [...this.inboxMessages.items],
    };

    const repos: TransactionalRepositories = {
      wallets: {
        save: async (wallet) => {
          await this.wallets.save(wallet);
          if (this.failAfterWalletSave) {
            throw new Error('falha simulada após save da wallet');
          }
        },
        findById: (id) => this.wallets.findById(id),
        findByIdForUpdate: (id) => this.wallets.findByIdForUpdate(id),
        findByPlayerIdAndCurrency: (playerId, currency) =>
          this.wallets.findByPlayerIdAndCurrency(playerId, currency),
      },
      wagerTransactions: this.wagerTransactions,
      ledgerEntries: this.ledgerEntries,
      outboxMessages: this.outboxMessages,
      inboxMessages: this.inboxMessages,
    };

    try {
      return await work(repos);
    } catch (error) {
      this.wallets.items.clear();
      for (const [id, wallet] of snapshot.wallets) {
        this.wallets.items.set(id, wallet);
      }
      this.wagerTransactions.items.length = 0;
      this.wagerTransactions.items.push(...snapshot.txs);
      this.ledgerEntries.items.length = 0;
      this.ledgerEntries.items.push(...snapshot.ledger);
      this.outboxMessages.items.length = 0;
      this.outboxMessages.items.push(...snapshot.outbox);
      this.inboxMessages.items.length = 0;
      this.inboxMessages.items.push(...snapshot.inbox);
      throw error;
    }
  }
}

describe('OpenWalletUseCase', () => {
  it('saldo zero cria somente a carteira com version 1', async () => {
    const uow = new InMemoryUnitOfWork();
    const useCase = new OpenWalletUseCase(uow);
    const playerId = randomUUID();

    const result = await useCase.execute({
      playerId,
      currency: 'BRL',
      initialBalance: '0.00',
    });

    expect(result.version).toBe(1);
    expect(result.balance).toBe('0.00');
    expect(uow.wallets.items.size).toBe(1);
    expect(uow.wagerTransactions.items).toHaveLength(0);
    expect(uow.ledgerEntries.items).toHaveLength(0);
    expect(uow.outboxMessages.items).toHaveLength(0);
  });

  it('saldo positivo cria wallet, OPENING, CREDIT e dois eventos', async () => {
    const uow = new InMemoryUnitOfWork();
    const useCase = new OpenWalletUseCase(uow);
    const playerId = randomUUID();

    const result = await useCase.execute({
      playerId,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    expect(result.balance).toBe('100.00');
    expect(result.version).toBe(1);
    expect(uow.wallets.items.size).toBe(1);
    expect(uow.wagerTransactions.items).toHaveLength(1);
    expect(uow.wagerTransactions.items[0].type).toBe('OPENING');
    expect(uow.wagerTransactions.items[0].status).toBe('PROCESSED');
    expect(uow.wagerTransactions.items[0].observedBalance?.toString()).toBe(
      '100.00',
    );
    expect(uow.wagerTransactions.items[0].observedWalletVersion).toBe(1);
    expect(uow.ledgerEntries.items).toHaveLength(1);
    expect(uow.ledgerEntries.items[0].direction).toBe('CREDIT');
    expect(uow.outboxMessages.items).toHaveLength(2);

    const types = uow.outboxMessages.items.map((m) => m.eventType).sort();
    expect(types).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    const processed = uow.outboxMessages.items.find(
      (m) => m.eventType === 'WagerTransactionProcessed',
    )!;
    const balanceChanged = uow.outboxMessages.items.find(
      (m) => m.eventType === 'WalletBalanceChanged',
    )!;

    expect(processed.aggregateId).toBe(uow.wagerTransactions.items[0].id);
    expect(balanceChanged.aggregateId).toBe(result.id);
    expect(balanceChanged.payload.data).toMatchObject({
      walletId: result.id,
      direction: 'CREDIT',
      money: { amount: '100.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      walletVersion: 1,
    });
    expect(typeof (balanceChanged.payload.data as { money: { amount: string } }).money.amount).toBe(
      'string',
    );
  });

  it('rejeita saldo negativo', async () => {
    const uow = new InMemoryUnitOfWork();
    const useCase = new OpenWalletUseCase(uow);

    await expect(
      useCase.execute({
        playerId: randomUUID(),
        currency: 'BRL',
        initialBalance: '-1.00',
      }),
    ).rejects.toBeInstanceOf(InvalidMoneyError);

    expect(uow.wallets.items.size).toBe(0);
  });

  it('rejeita carteira duplicada para playerId+currency', async () => {
    const uow = new InMemoryUnitOfWork();
    const useCase = new OpenWalletUseCase(uow);
    const playerId = randomUUID();

    await useCase.execute({
      playerId,
      currency: 'BRL',
      initialBalance: '0.00',
    });

    await expect(
      useCase.execute({
        playerId,
        currency: 'BRL',
        initialBalance: '10.00',
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  it('em falha após save da wallet não deixa efeitos financeiros no fake UoW', async () => {
    const uow = new InMemoryUnitOfWork();
    uow.failAfterWalletSave = true;
    const useCase = new OpenWalletUseCase(uow);

    await expect(
      useCase.execute({
        playerId: randomUUID(),
        currency: 'BRL',
        initialBalance: '50.00',
      }),
    ).rejects.toThrow('falha simulada');

    expect(uow.wallets.items.size).toBe(0);
    expect(uow.wagerTransactions.items).toHaveLength(0);
    expect(uow.ledgerEntries.items).toHaveLength(0);
    expect(uow.outboxMessages.items).toHaveLength(0);
  });
});
