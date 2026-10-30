import { InboxConsumer } from '../../src/application/messaging/inbox-consumer';
import {
  clearTrackedSqsReceipts,
  trackedSqsReceiptCount,
} from '../../src/application/messaging/active-sqs-receipts';
import {
  markShutdownAbandonInFlight,
  resetShutdownGate,
  shutdownGate,
} from '../../src/application/messaging/shutdown-gate';
import type {
  MessageBus,
  ReceivedBusMessage,
} from '../../src/application/ports/message-bus';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { DomainEventHandler } from '../../src/application/messaging/domain-event-handler';
import { ConsoleMessagingLogger } from '../../src/infrastructure/logging/console-messaging-logger';
import {
  MessagingWorkersHost,
  waitForInFlight,
} from '../../src/infrastructure/messaging/messaging-workers.host';
import { FakeInboxRepository } from '../helpers/fake-inbox';

class MemoryBus implements MessageBus {
  queue: ReceivedBusMessage[] = [];
  acked: string[] = [];
  visibility: Array<{ receiptHandle: string; seconds: number }> = [];

  async publish(): Promise<void> {}
  async receive(max: number): Promise<ReceivedBusMessage[]> {
    return this.queue.splice(0, max);
  }
  async ack(receiptHandle: string): Promise<void> {
    this.acked.push(receiptHandle);
  }
  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    this.visibility.push({ receiptHandle, seconds });
  }
  async checkAvailable(): Promise<void> {}
}

describe('Shutdown abandon + ChangeMessageVisibility(0)', () => {
  const originalHold = process.env.SHUTDOWN_TEST_HOLD_MS;

  afterEach(() => {
    resetShutdownGate();
    clearTrackedSqsReceipts();
    if (originalHold === undefined) {
      delete process.env.SHUTDOWN_TEST_HOLD_MS;
    } else {
      process.env.SHUTDOWN_TEST_HOLD_MS = originalHold;
    }
  });

  it('abandonInFlight: não faz ACK e chama visibility=0 (best-effort)', async () => {
    process.env.SHUTDOWN_TEST_HOLD_MS = '30';
    const bus = new MemoryBus();
    bus.queue.push({
      id: 'evt-1',
      body: JSON.stringify({
        eventId: 'evt-1',
        eventType: 'WalletBalanceChanged',
        aggregateId: 'a',
        correlationId: 'c',
        occurredAt: new Date().toISOString(),
        version: 1,
        data: {},
      }),
      receiptHandle: 'rh-1',
      transportMessageId: 'tm-1',
      receiveCount: 1,
    });

    const uow: UnitOfWork = {
      run: async (work) =>
        work({
          inboxMessages: new FakeInboxRepository(),
          wallets: {} as never,
          wagerTransactions: { findById: async () => null } as never,
          ledgerEntries: {} as never,
          outboxMessages: {} as never,
        } as TransactionalRepositories),
    };

    const handler = {
      handleWithRepos: async () => 'ignored' as const,
    } as unknown as DomainEventHandler;

    const consumer = new InboxConsumer(
      bus,
      uow,
      handler,
      new ConsoleMessagingLogger(),
      { maxMessages: 10, waitSeconds: 0 },
    );

    const poll = consumer.pollOnce();
    await new Promise((r) => setTimeout(r, 5));
    expect(trackedSqsReceiptCount()).toBe(1);

    markShutdownAbandonInFlight();
    await poll;

    expect(bus.acked).toHaveLength(0);
    expect(bus.visibility).toEqual(
      expect.arrayContaining([{ receiptHandle: 'rh-1', seconds: 0 }]),
    );
    expect(shutdownGate.abandonInFlight).toBe(true);
  });

  it('Host no drain_timeout marca abandon e libera receipts tracked', async () => {
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '60000';
    process.env.WORKER_INBOX_INTERVAL_MS = '15';
    process.env.WORKER_INBOUND_INTERVAL_MS = '60000';
    process.env.WORKER_PENDING_INTERVAL_MS = '60000';
    process.env.SHUTDOWN_DRAIN_MS = '40';
    process.env.SHUTDOWN_TEST_HOLD_MS = '500';

    const bus = new MemoryBus();
    bus.queue.push({
      id: 'evt-2',
      body: JSON.stringify({
        eventId: 'evt-2',
        eventType: 'WalletBalanceChanged',
        aggregateId: 'a',
        correlationId: 'c',
        occurredAt: new Date().toISOString(),
        version: 1,
        data: {},
      }),
      receiptHandle: 'rh-2',
      transportMessageId: 'tm-2',
      receiveCount: 1,
    });

    const uow: UnitOfWork = {
      run: async (work) =>
        work({
          inboxMessages: new FakeInboxRepository(),
          wallets: {} as never,
          wagerTransactions: { findById: async () => null } as never,
          ledgerEntries: {} as never,
          outboxMessages: {} as never,
        } as TransactionalRepositories),
    };

    const inboxConsumer = new InboxConsumer(
      bus,
      uow,
      { handleWithRepos: async () => 'ignored' as const } as never,
      new ConsoleMessagingLogger(),
      { maxMessages: 10, waitSeconds: 0 },
    );

    const host = new MessagingWorkersHost({
      outboxPublisher: {
        publishBatch: jest.fn().mockResolvedValue({
          claimed: 0,
          published: 0,
          failed: 0,
        }),
      },
      inboxConsumer,
      inboundWagerConsumer: {
        pollOnce: jest.fn().mockResolvedValue({
          received: 0,
          processed: 0,
          duplicates: 0,
          failed: 0,
        }),
      },
      processPendingReferences: {
        processBatch: jest.fn().mockResolvedValue({
          claimed: 0,
          processed: 0,
          rejected: 0,
          expired: 0,
          deferred: 0,
          skipped: 0,
        }),
      },
    } as never);

    host.onModuleInit();
    await new Promise((r) => setTimeout(r, 40));
    await host.beforeApplicationShutdown('SIGTERM');

    expect(shutdownGate.abandonInFlight).toBe(true);

    // Hold (500ms) ainda pode estar ativo — aguarda abandono sem ACK.
    await new Promise((r) => setTimeout(r, 700));
    host.onModuleDestroy();

    expect(bus.acked).toHaveLength(0);
    expect(
      bus.visibility.some((v) => v.receiptHandle === 'rh-2' && v.seconds === 0),
    ).toBe(true);
  });
});
