import { randomUUID } from 'node:crypto';
import { OutboxPublisher } from '../../src/application/messaging/outbox-publisher';
import type {
  BusMessage,
  MessageBus,
  ReceivedBusMessage,
} from '../../src/application/ports/message-bus';
import type { MessagingLogger } from '../../src/application/ports/messaging-logger';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../src/domain/outbox/outbox-message.repository';

class RecordingLogger implements MessagingLogger {
  events: Array<{ level: string; event: string; payload: Record<string, unknown> }> =
    [];
  info(event: string, payload?: Record<string, unknown>) {
    this.events.push({ level: 'info', event, payload: payload ?? {} });
  }
  error(event: string, payload?: Record<string, unknown>) {
    this.events.push({ level: 'error', event, payload: payload ?? {} });
  }
  warn(event: string, payload?: Record<string, unknown>) {
    this.events.push({ level: 'warn', event, payload: payload ?? {} });
  }
}

class FakeOutbox implements OutboxMessageRepository {
  items: OutboxMessage[] = [];
  interventionCalls = 0;
  failedCalls = 0;

  async save(message: OutboxMessage): Promise<void> {
    this.items.push(message);
  }
  async findByAggregateId(): Promise<OutboxMessage[]> {
    return [];
  }
  async findById(id: string): Promise<OutboxMessage | null> {
    return this.items.find((m) => m.id === id) ?? null;
  }
  async claimUnpublished(): Promise<OutboxMessage[]> {
    return this.items.filter(
      (m) => !m.isPublished && !m.requiresIntervention,
    );
  }
  async markPublished(id: string): Promise<void> {
    this.items.find((m) => m.id === id)?.markPublished();
  }
  async markPublishFailed(
    id: string,
    nextAttemptAt: Date,
    lastError?: string | null,
  ): Promise<void> {
    this.failedCalls += 1;
    this.items
      .find((m) => m.id === id)
      ?.markPublishFailed(nextAttemptAt, lastError ?? 'err');
  }
  async markInterventionRequired(
    id: string,
    lastError: string,
  ): Promise<boolean> {
    this.interventionCalls += 1;
    const msg = this.items.find((m) => m.id === id);
    if (!msg || msg.requiresIntervention) {
      return false;
    }
    msg.markInterventionRequired(lastError);
    return true;
  }
  async clearIntervention(id: string, nextAttemptAt?: Date): Promise<boolean> {
    const msg = this.items.find((m) => m.id === id);
    if (!msg?.requiresIntervention) {
      return false;
    }
    msg.clearIntervention(nextAttemptAt ?? new Date());
    return true;
  }
}

function envelope(id = randomUUID()) {
  return {
    eventId: id,
    eventType: 'WagerTransactionProcessed',
    aggregateId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    version: 1 as const,
    data: {},
  };
}

describe('OutboxPublisher intervention (unit)', () => {
  function setup(attempts: number) {
    const outbox = new FakeOutbox();
    const msg = OutboxMessage.fromEnvelope(envelope());
    msg.applyClaim(new Date(Date.now() + 30_000), attempts);
    outbox.items.push(msg);

    const logger = new RecordingLogger();
    const bus: MessageBus = {
      publish: async () => {
        throw new Error('sqs-unavailable password=leak');
      },
      receive: async (): Promise<ReceivedBusMessage[]> => [],
      ack: async () => undefined,
    };

    const repos = {
      outboxMessages: outbox,
    } as unknown as TransactionalRepositories;
    const uow: UnitOfWork = {
      run: async (work) => work(repos),
    };

    const publisher = new OutboxPublisher(
      uow,
      bus,
      logger,
      { batchSize: 10, leaseSeconds: 30 },
    );

    return { publisher, outbox, logger, msg };
  }

  it('com menos de 10 attempts agenda retry e não pausa', async () => {
    const { publisher, outbox, logger, msg } = setup(9);
    const result = await publisher.publishBatch();
    expect(result.failed).toBe(1);
    expect(outbox.failedCalls).toBe(1);
    expect(outbox.interventionCalls).toBe(0);
    expect(msg.requiresIntervention).toBe(false);
    expect(
      logger.events.filter((e) => e.event === 'outbox.publish_failed'),
    ).toHaveLength(1);
    expect(
      logger.events.filter((e) => e.event === 'outbox.intervention_required'),
    ).toHaveLength(0);
    const failLog = logger.events.find((e) => e.event === 'outbox.publish_failed');
    expect(String(failLog?.payload.error)).not.toContain('leak');
  });

  it('com 10 attempts exige intervenção uma única vez', async () => {
    const { publisher, outbox, logger, msg } = setup(10);
    const result = await publisher.publishBatch();
    expect(result.failed).toBe(1);
    expect(outbox.interventionCalls).toBe(1);
    expect(msg.requiresIntervention).toBe(true);
    expect(msg.lockedUntil).toBeNull();
    expect(
      logger.events.filter((e) => e.event === 'outbox.intervention_required'),
    ).toHaveLength(1);
    expect(
      logger.events.filter((e) => e.event === 'outbox.publish_failed'),
    ).toHaveLength(1);

    // Segunda falha simulada (já pausado / markIntervention retorna false)
    outbox.items = [msg];
    const busOk: MessageBus = {
      publish: async (_m: BusMessage) => {
        throw new Error('still-failing');
      },
      receive: async () => [],
      ack: async () => undefined,
    };
    // claimUnpublished exclui intervention — batch vazio
    const result2 = await new OutboxPublisher(
      { run: async (work) => work({ outboxMessages: outbox } as never) },
      busOk,
      logger,
      { batchSize: 10, leaseSeconds: 30 },
    ).publishBatch();
    expect(result2.claimed).toBe(0);
    expect(
      logger.events.filter((e) => e.event === 'outbox.intervention_required'),
    ).toHaveLength(1);
  });
});
