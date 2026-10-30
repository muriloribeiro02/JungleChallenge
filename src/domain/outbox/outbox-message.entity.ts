import type { DomainEventEnvelope } from './domain-event';

/**
 * Mensagem de outbox pronta para persistência (payload = envelope versionado).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: DomainEventEnvelope,
    public readonly occurredAt: Date,
    public readonly attempts: number,
    public readonly nextAttemptAt: Date | null,
    public readonly publishedAt: Date | null,
  ) {}

  static fromEnvelope(envelope: DomainEventEnvelope): OutboxMessage {
    return new OutboxMessage(
      envelope.eventId,
      envelope.aggregateId,
      envelope.eventType,
      envelope,
      new Date(envelope.occurredAt),
      0,
      null,
      null,
    );
  }
}
