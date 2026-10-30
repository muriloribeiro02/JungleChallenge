import type { DomainEventEnvelope } from '../../../domain/outbox/domain-event';
import { OutboxMessage } from '../../../domain/outbox/outbox-message.entity';
import { OutboxMessageOrmEntity } from './outbox-message.orm-entity';

export class OutboxMessageMapper {
  static toPersistence(message: OutboxMessage): OutboxMessageOrmEntity {
    const row = new OutboxMessageOrmEntity();
    row.id = message.id;
    row.aggregateId = message.aggregateId;
    row.eventType = message.eventType;
    row.payload = message.payload as unknown as Record<string, unknown>;
    row.occurredAt = message.occurredAt;
    row.attempts = message.attempts;
    row.nextAttemptAt = message.nextAttemptAt;
    row.publishedAt = message.publishedAt;
    row.lockedUntil = message.lockedUntil;
    return row;
  }

  static toDomain(row: OutboxMessageOrmEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload as unknown as DomainEventEnvelope,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      publishedAt: row.publishedAt,
      lockedUntil: row.lockedUntil ?? null,
    });
  }
}
