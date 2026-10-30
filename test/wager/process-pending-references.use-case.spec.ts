import { randomUUID } from 'node:crypto';
import { ProcessPendingReferencesUseCase } from '../../src/application/use-cases/wager/process-pending-references.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/wager/reprocess-pending-references.use-case';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { Money } from '../../src/domain/money/money';
import type { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../src/domain/outbox/outbox-message.repository';
import {
  FAILURE_CODE_REFERENCE_NOT_FOUND,
  WagerTransaction,
} from '../../src/domain/wager-transaction/wager-transaction.entity';
import type { WagerTransactionRepository } from '../../src/domain/wager-transaction/wager-transaction.repository';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import type { WalletRepository } from '../../src/domain/wallet/wallet.repository';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger/wallet-ledger-entry.entity';
import type { WalletLedgerEntryRepository } from '../../src/domain/wallet-ledger/wallet-ledger-entry.repository';
import { ConsoleMessagingLogger } from '../../src/infrastructure/logging/console-messaging-logger';
import { FakeInboxRepository } from '../helpers/fake-inbox';

class FakeWallets implements WalletRepository {
  constructor(private current: Wallet | null) {}
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
  claimCalls = 0;

  async save(tx: WagerTransaction): Promise<void> {
    const idx = this.items.findIndex((t) => t.id === tx.id);
    if (idx >= 0) this.items[idx] = tx;
    else this.items.push(tx);
  }
  async findByProviderIdAndIdempotencyKey(): Promise<WagerTransaction | null> {
    return null;
  }
  async findByProviderIdAndExternalTransactionId(): Promise<WagerTransaction | null> {
    return null;
  }
  async findProcessedReversalByProviderAndExternalReference(): Promise<WagerTransaction | null> {
    return null;
  }
  async findPendingByProviderAndExternalReference(): Promise<WagerTransaction[]> {
    return [];
  }
  async findById(id: string): Promise<WagerTransaction | null> {
    return this.items.find((t) => t.id === id) ?? null;
  }
  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    return this.findById(id);
  }
  async claimDuePendingReferences(limit: number): Promise<WagerTransaction[]> {
    this.claimCalls += 1;
    const now = new Date();
    const due = this.items.filter((t) => {
      if (t.status !== 'PENDING_REFERENCE' || !t.pendingReferenceAt) return false;
      if (t.lockedUntil && t.lockedUntil >= now) return false;
      const expired =
        now.getTime() - t.pendingReferenceAt.getTime() >= 24 * 60 * 60 * 1000;
      return expired || !t.nextAttemptAt || t.nextAttemptAt <= now;
    });
    const claimed = due.slice(0, limit);
    for (const tx of claimed) {
      tx.applyClaimLease(new Date(now.getTime() + 30_000));
    }
    return claimed;
  }
}

class FakeLedger implements WalletLedgerEntryRepository {
  items: WalletLedgerEntry[] = [];
  async save(e: WalletLedgerEntry): Promise<void> {
    this.items.push(e);
  }
  async listByWalletId() {
    return { items: this.items, nextCursor: null };
  }
  async listAllByWalletId(): Promise<WalletLedgerEntry[]> {
    return this.items;
  }
  async countByWalletId(): Promise<number> {
    return this.items.length;
  }
}

class FakeOutbox implements OutboxMessageRepository {
  items: OutboxMessage[] = [];
  async save(message: OutboxMessage): Promise<void> {
    this.items.push(message);
  }
  async findByAggregateId(): Promise<OutboxMessage[]> {
    return [];
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

describe('ProcessPendingReferencesUseCase (unit)', () => {
  it('claim + expira TTL com REFERENCE_NOT_FOUND e um único evento', async () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
    const txs = new FakeTx();
    const outbox = new FakeOutbox();
    const ledger = new FakeLedger();
    const repos: TransactionalRepositories = {
      wallets: new FakeWallets(wallet),
      wagerTransactions: txs,
      ledgerEntries: ledger,
      outboxMessages: outbox,
      inboxMessages: new FakeInboxRepository(),
    };
    const uow: UnitOfWork = {
      run: async (work) => work(repos),
    };

    const pending = WagerTransaction.refundPendingReference({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: Money.from({ amount: '10.00', currency: 'BRL' }),
      providerId: 'p',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      payloadHash: 'h',
      roundId: 'r',
      gameId: 'g',
      externalReference: randomUUID(),
    });
    txs.items.push(
      WagerTransaction.rehydrate({
        id: pending.id,
        walletId: pending.walletId,
        playerId: pending.playerId,
        type: pending.kind,
        status: pending.status,
        amount: {
          amount: pending.amount.toString(),
          currency: pending.amount.currency,
        },
        providerId: pending.providerId,
        externalTransactionId: pending.externalTransactionId,
        idempotencyKey: pending.idempotencyKey,
        payloadHash: pending.payloadHash,
        roundId: pending.roundId,
        gameId: pending.gameId,
        failureCode: null,
        externalReference: pending.externalReference,
        createdAt: pending.createdAt,
        updatedAt: pending.updatedAt,
        pendingReferenceAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        pendingAttemptCount: 0,
        nextAttemptAt: new Date(Date.now() + 120_000),
      }),
    );

    const reprocess = new ReprocessPendingReferencesUseCase(uow);
    const worker = new ProcessPendingReferencesUseCase(
      uow,
      reprocess,
      new ConsoleMessagingLogger(),
      { batchSize: 10, leaseSeconds: 30 },
    );

    const first = await worker.processBatch();
    expect(first.claimed).toBe(1);
    expect(first.expired).toBe(1);
    expect(first.rejected).toBe(1);
    expect(ledger.items).toHaveLength(0);
    expect(
      outbox.items.filter((m) => m.eventType === 'WagerTransactionRejected'),
    ).toHaveLength(1);
    const rejectedPayload = outbox.items[0]?.payload.data;
    expect(
      rejectedPayload &&
        typeof rejectedPayload === 'object' &&
        'failureCode' in rejectedPayload
        ? rejectedPayload.failureCode
        : undefined,
    ).toBe(FAILURE_CODE_REFERENCE_NOT_FOUND);

    const second = await worker.processBatch();
    expect(second.claimed).toBe(0);
    expect(
      outbox.items.filter((m) => m.eventType === 'WagerTransactionRejected'),
    ).toHaveLength(1);
  });
});
