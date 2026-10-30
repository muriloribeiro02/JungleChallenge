import { randomUUID } from 'node:crypto';
import { ClearOutboxInterventionUseCase } from '../../src/application/use-cases/outbox/clear-outbox-intervention.use-case';
import type { MessagingLogger } from '../../src/application/ports/messaging-logger';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import {
  OutboxEventAlreadyPublishedError,
  OutboxEventNotAwaitingInterventionError,
  OutboxEventNotFoundError,
} from '../../src/domain/outbox/outbox-intervention.errors';
import { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../src/domain/outbox/outbox-message.repository';

class RecordingLogger implements MessagingLogger {
  events: string[] = [];
  info(event: string) {
    this.events.push(event);
  }
  error(event: string) {
    this.events.push(event);
  }
  warn(event: string) {
    this.events.push(event);
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
  async findById(id: string): Promise<OutboxMessage | null> {
    return this.items.find((m) => m.id === id) ?? null;
  }
  async claimUnpublished(): Promise<OutboxMessage[]> {
    return this.items.filter((m) => !m.isPublished && !m.requiresIntervention);
  }
  async markPublished(): Promise<void> {}
  async markPublishFailed(): Promise<void> {}
  async markInterventionRequired(): Promise<boolean> {
    return false;
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

function makePaused(attempts = 10): OutboxMessage {
  const msg = OutboxMessage.fromEnvelope({
    eventId: randomUUID(),
    eventType: 'WagerTransactionProcessed',
    aggregateId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    version: 1,
    data: { note: 'preserve-me' },
  });
  msg.applyClaim(new Date(), attempts);
  msg.markInterventionRequired('sqs-down');
  return msg;
}

describe('ClearOutboxInterventionUseCase (unit)', () => {
  function setup(msg?: OutboxMessage) {
    const outbox = new FakeOutbox();
    if (msg) {
      outbox.items.push(msg);
    }
    const logger = new RecordingLogger();
    const repos = { outboxMessages: outbox } as unknown as TransactionalRepositories;
    const uow: UnitOfWork = { run: async (work) => work(repos) };
    return {
      outbox,
      logger,
      useCase: new ClearOutboxInterventionUseCase(uow, logger),
      msg,
    };
  }

  it('libera intervenção preservando attempts/payload/eventId', async () => {
    const paused = makePaused(12);
    const payloadBefore = JSON.stringify(paused.payload);
    const { useCase, logger } = setup(paused);

    const result = await useCase.execute({ eventId: paused.id });

    expect(result.eventId).toBe(paused.id);
    expect(result.attempts).toBe(12);
    expect(paused.requiresIntervention).toBe(false);
    expect(paused.attempts).toBe(12);
    expect(JSON.stringify(paused.payload)).toBe(payloadBefore);
    expect(logger.events).toContain('outbox.intervention_cleared');
  });

  it('falha se evento não existe', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute({ eventId: randomUUID() }),
    ).rejects.toBeInstanceOf(OutboxEventNotFoundError);
  });

  it('falha se não está em intervenção', async () => {
    const msg = OutboxMessage.fromEnvelope({
      eventId: randomUUID(),
      eventType: 'WagerTransactionProcessed',
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {},
    });
    const { useCase } = setup(msg);
    await expect(
      useCase.execute({ eventId: msg.id }),
    ).rejects.toBeInstanceOf(OutboxEventNotAwaitingInterventionError);
  });

  it('falha se já publicado', async () => {
    const msg = makePaused();
    msg.markPublished();
    // published clears intervention flag in markPublished? Our markPublished doesn't clear intervention.
    // Force published state via markPublished — still has intervention_required_at in domain.
    // Use rehydrate for published without intervention edge: mark published then clear intervention flag manually.
    const published = OutboxMessage.rehydrate({
      id: msg.id,
      aggregateId: msg.aggregateId,
      eventType: msg.eventType,
      payload: msg.payload,
      occurredAt: msg.occurredAt,
      attempts: msg.attempts,
      nextAttemptAt: null,
      publishedAt: new Date(),
      lockedUntil: null,
      lastError: 'x',
      lastFailedAt: new Date(),
      interventionRequiredAt: new Date(),
    });
    const { useCase } = setup(published);
    await expect(
      useCase.execute({ eventId: published.id }),
    ).rejects.toBeInstanceOf(OutboxEventAlreadyPublishedError);
  });
});
