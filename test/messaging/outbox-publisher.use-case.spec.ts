import { randomUUID } from 'node:crypto';
import { OutboxPublisher, computeNextAttemptAt } from '../../src/application/messaging/outbox-publisher';
import type {
  BusMessage,
  MessageBus,
  ReceivedBusMessage,
} from '../../src/application/ports/message-bus';
import { OutboxMessage } from '../../src/domain/outbox/outbox-message.entity';
import type { DomainEventEnvelope } from '../../src/domain/events/domain-event';

class FakeBus implements MessageBus {
  published: BusMessage[] = [];
  failIds = new Set<string>();

  async publish(message: BusMessage): Promise<void> {
    if (this.failIds.has(message.id)) {
      throw new Error('sqs-unavailable');
    }
    this.published.push(message);
  }

  async receive(): Promise<ReceivedBusMessage[]> {
    return [];
  }

  async ack(): Promise<void> {}
}

describe('OutboxPublisher helpers (unit)', () => {
  it('computeNextAttemptAt usa backoff exponencial limitado a 300s', () => {
    const base = new Date('2026-10-30T12:00:00.000Z');
    expect(computeNextAttemptAt(1, base).getTime() - base.getTime()).toBe(2000);
    expect(computeNextAttemptAt(8, base).getTime() - base.getTime()).toBe(
      256_000,
    );
    expect(computeNextAttemptAt(20, base).getTime() - base.getTime()).toBe(
      300_000,
    );
  });

  it('OutboxMessage markPublished limpa lease', () => {
    const envelope: DomainEventEnvelope = {
      eventId: randomUUID(),
      eventType: 'WagerTransactionProcessed',
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {},
    };
    const msg = OutboxMessage.fromEnvelope(envelope);
    msg.applyClaim(new Date(), 1);
    msg.markPublished();
    expect(msg.publishedAt).not.toBeNull();
    expect(msg.lockedUntil).toBeNull();
  });

  it('OutboxPublisher type exists with MessageBus dependency', () => {
    const bus = new FakeBus();
    expect(bus).toBeDefined();
    expect(OutboxPublisher.name).toBe('OutboxPublisher');
  });
});
