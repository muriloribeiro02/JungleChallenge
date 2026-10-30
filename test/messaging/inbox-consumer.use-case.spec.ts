import { randomUUID } from 'node:crypto';
import { DomainEventHandler } from '../../src/application/messaging/domain-event-handler';
import { InboxConsumer } from '../../src/application/messaging/inbox-consumer';
import type {
  MessageBus,
  ReceivedBusMessage,
} from '../../src/application/ports/message-bus';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import {
  InboxMessage,
  INBOX_CONSUMER_DOMAIN_EVENTS,
} from '../../src/domain/inbox/inbox-message.entity';
import type { DomainEventEnvelope } from '../../src/domain/events/domain-event';
import { ConsoleMessagingLogger } from '../../src/infrastructure/logging/console-messaging-logger';
import { FakeInboxRepository } from '../helpers/fake-inbox';

const logger = new ConsoleMessagingLogger();
const defaultOptions = { maxMessages: 10, waitSeconds: 0 };

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

  enqueue(envelope: DomainEventEnvelope, receiveCount = 1): void {
    this.queue.push({
      id: envelope.eventId,
      body: JSON.stringify(envelope),
      receiptHandle: `rh-${envelope.eventId}`,
      transportMessageId: `tm-${envelope.eventId}`,
      receiveCount,
    });
  }
}

class StubUow implements UnitOfWork {
  inbox = new FakeInboxRepository();
  handlerCalls = 0;
  failHandler = false;

  async run<T>(
    work: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = [...this.inbox.items];
    const repos = {
      inboxMessages: this.inbox,
      wallets: {} as never,
      wagerTransactions: {
        findById: async () => null,
      } as never,
      ledgerEntries: {} as never,
      outboxMessages: {} as never,
    };
    try {
      return await work(repos);
    } catch (error) {
      this.inbox.items.length = 0;
      this.inbox.items.push(...snapshot);
      throw error;
    }
  }
}

describe('InboxConsumer (unit)', () => {
  it('mensagem nova grava inbox e faz ACK', async () => {
    const bus = new MemoryBus();
    const uow = new StubUow();
    const handler = {
      handleWithRepos: async () => {
        uow.handlerCalls += 1;
        return 'ignored' as const;
      },
    } as unknown as DomainEventHandler;

    const consumer = new InboxConsumer(
      bus,
      uow,
      handler,
      logger,
      defaultOptions,
    );
    const envelope: DomainEventEnvelope = {
      eventId: randomUUID(),
      eventType: 'WalletBalanceChanged',
      aggregateId: randomUUID(),
      correlationId: 'corr-1',
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {},
    };
    bus.enqueue(envelope);

    const result = await consumer.pollOnce();
    expect(result.processed).toBe(1);
    expect(uow.inbox.items).toHaveLength(1);
    expect(bus.acked).toHaveLength(1);
    expect(uow.handlerCalls).toBe(1);
  });

  it('duplicata não chama handler de efeito e ainda faz ACK', async () => {
    const bus = new MemoryBus();
    const uow = new StubUow();
    const eventId = randomUUID();
    await uow.inbox.tryInsert(
      InboxMessage.record({
        id: eventId,
        consumerName: INBOX_CONSUMER_DOMAIN_EVENTS,
        eventType: 'WalletBalanceChanged',
      }),
    );

    const handler = {
      handleWithRepos: async () => {
        uow.handlerCalls += 1;
        return 'ignored' as const;
      },
    } as unknown as DomainEventHandler;

    const consumer = new InboxConsumer(
      bus,
      uow,
      handler,
      logger,
      defaultOptions,
    );
    bus.enqueue({
      eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: randomUUID(),
      correlationId: 'corr-2',
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {},
    });

    const result = await consumer.pollOnce();
    expect(result.duplicates).toBe(1);
    expect(uow.handlerCalls).toBe(0);
    expect(bus.acked).toHaveLength(1);
  });

  it('falha antes do commit não faz ACK', async () => {
    const bus = new MemoryBus();
    const uow = new StubUow();
    const handler = {
      handleWithRepos: async () => {
        throw new Error('boom-before-commit');
      },
    } as unknown as DomainEventHandler;

    const consumer = new InboxConsumer(
      bus,
      uow,
      handler,
      logger,
      defaultOptions,
    );
    bus.enqueue({
      eventId: randomUUID(),
      eventType: 'WagerTransactionProcessed',
      aggregateId: randomUUID(),
      correlationId: 'corr-3',
      occurredAt: new Date().toISOString(),
      version: 1,
      data: { transactionId: randomUUID(), kind: 'BET' },
    });

    const result = await consumer.pollOnce();
    expect(result.failed).toBe(1);
    expect(bus.acked).toHaveLength(0);
    expect(bus.visibility).toEqual([
      { receiptHandle: expect.stringMatching(/^rh-/), seconds: 0 },
    ]);
  });
});
