import { randomUUID } from 'node:crypto';
import { Registry } from 'prom-client';
import { InboxConsumer } from '../../src/application/messaging/inbox-consumer';
import { OutboxPublisher } from '../../src/application/messaging/outbox-publisher';
import type {
  BusMessage,
  MessageBus,
  ReceivedBusMessage,
} from '../../src/application/ports/message-bus';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { SubmitWagerTransactionUseCase } from '../../src/application/use-cases/wager/submit-wager-transaction.use-case';
import { DomainEventHandler } from '../../src/application/messaging/domain-event-handler';
import type { DomainEventEnvelope } from '../../src/domain/events/domain-event';
import { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import { ConsoleMessagingLogger } from '../../src/infrastructure/logging/console-messaging-logger';
import { createPrometheusMetrics } from '../../src/infrastructure/metrics/prometheus-metrics';
import { FakeInboxRepository } from '../helpers/fake-inbox';

describe('Instrumentação de métricas (unit)', () => {
  it('Submit registra PROCESSED sem alterar o resultado financeiro', async () => {
    const registry = new Registry();
    const metrics = createPrometheusMetrics({ registry });
    const txId = randomUUID();
    const placeBet = {
      executeWithRepos: jest.fn(async () => ({
        transactionId: txId,
        status: 'PROCESSED',
        observedBalance: '90.00',
        currency: 'BRL',
      })),
    };
    const uow: UnitOfWork = {
      run: async (work) =>
        work({
          wallets: {} as never,
          wagerTransactions: {
            findByProviderIdAndIdempotencyKey: async () => null,
          } as never,
          ledgerEntries: {} as never,
          outboxMessages: {} as never,
          inboxMessages: {} as never,
        }),
    };
    const uc = new SubmitWagerTransactionUseCase(
      uow,
      placeBet as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      { executeWithRepos: async () => ({}) } as never,
      metrics,
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
      idempotencyKey: 'k',
    });

    expect(result).toEqual({
      transactionId: txId,
      status: 'PROCESSED',
      balance: { amount: '90.00', currency: 'BRL' },
      failureCode: undefined,
      idempotentReplay: false,
    });
    const body = await metrics.collect();
    expect(body).toMatch(
      /dwp_wager_transactions_total\{[^}]*status="PROCESSED"[^}]*\} 1/,
    );
  });

  it('Inbox incrementa duplicate e processed', async () => {
    const registry = new Registry();
    const metrics = createPrometheusMetrics({ registry });
    const logger = new ConsoleMessagingLogger();
    const inbox = new FakeInboxRepository();

    class Bus implements MessageBus {
      queue: ReceivedBusMessage[] = [];
      async publish(): Promise<void> {}
      async receive(max: number): Promise<ReceivedBusMessage[]> {
        return this.queue.splice(0, max);
      }
      async ack(): Promise<void> {}
    }

    class Uow implements UnitOfWork {
      async run<T>(
        work: (repos: TransactionalRepositories) => Promise<T>,
      ): Promise<T> {
        return work({
          inboxMessages: inbox,
          wallets: {} as never,
          wagerTransactions: { findById: async () => null } as never,
          ledgerEntries: {} as never,
          outboxMessages: {} as never,
        });
      }
    }

    const bus = new Bus();
    const handler = {
      handleWithRepos: jest.fn(async () => undefined),
    } as unknown as DomainEventHandler;
    const consumer = new InboxConsumer(
      bus,
      new Uow(),
      handler,
      logger,
      { maxMessages: 10, waitSeconds: 0 },
      metrics,
    );

    const envelope = (id: string): DomainEventEnvelope => ({
      eventId: id,
      eventType: 'WagerTransactionProcessed',
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {},
    });

    const e1 = envelope(randomUUID());
    bus.queue.push({
      id: e1.eventId,
      body: JSON.stringify(e1),
      receiptHandle: 'rh-1',
      transportMessageId: 'tm-1',
      receiveCount: 1,
    });
    await consumer.pollOnce();

    bus.queue.push({
      id: e1.eventId,
      body: JSON.stringify(e1),
      receiptHandle: 'rh-2',
      transportMessageId: 'tm-2',
      receiveCount: 2,
    });
    await consumer.pollOnce();

    const body = await metrics.collect();
    expect(body).toContain('dwp_messaging_messages_processed_total');
    expect(body).toContain('dwp_messaging_messages_duplicate_total');
    expect(body).toContain('dwp_messaging_retries_total');
  });

  it('Outbox registra published e failed', async () => {
    const registry = new Registry();
    const metrics = createPrometheusMetrics({ registry });
    const logger = new ConsoleMessagingLogger();

    const okId = randomUUID();
    const failId = randomUUID();
    const messages = [okId, failId].map((id) =>
      OutboxMessage.fromEnvelope({
        eventId: id,
        eventType: 'WagerTransactionProcessed',
        aggregateId: randomUUID(),
        correlationId: randomUUID(),
        occurredAt: new Date(Date.now() - 2000).toISOString(),
        version: 1,
        data: {},
      }),
    );

    class Bus implements MessageBus {
      async publish(message: BusMessage): Promise<void> {
        if (message.id === failId) {
          throw new Error('sqs-down');
        }
      }
      async receive(): Promise<ReceivedBusMessage[]> {
        return [];
      }
      async ack(): Promise<void> {}
    }

    let claimed = false;
    const uow: UnitOfWork = {
      run: async (work) =>
        work({
          outboxMessages: {
            claimUnpublished: async () => {
              if (claimed) return [];
              claimed = true;
              return messages;
            },
            markPublished: async () => undefined,
            markPublishFailed: async () => undefined,
          } as never,
          wallets: {} as never,
          wagerTransactions: {} as never,
          ledgerEntries: {} as never,
          inboxMessages: {} as never,
        }),
    };

    const publisher = new OutboxPublisher(
      uow,
      new Bus(),
      logger,
      { batchSize: 10, leaseSeconds: 30 },
      metrics,
    );
    const result = await publisher.publishBatch();
    expect(result.published).toBe(1);
    expect(result.failed).toBe(1);

    const body = await metrics.collect();
    expect(body).toMatch(/dwp_outbox_events_published_total(?:\{[^}]*\})? 1/);
    expect(body).toMatch(
      /dwp_outbox_events_publish_failures_total(?:\{[^}]*\})? 1/,
    );
  });
});
