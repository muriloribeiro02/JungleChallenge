import type { DomainEventEnvelope } from './domain-event';

export type OutboxMessageState = {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: DomainEventEnvelope;
  occurredAt: Date | string;
  attempts: number;
  nextAttemptAt: Date | string | null;
  publishedAt: Date | string | null;
  lockedUntil: Date | string | null;
};

/**
 * Mensagem de outbox pronta para persistência (payload = envelope versionado).
 * Campos operacionais (attempts, next_attempt_at, published_at, locked_until)
 * são mutáveis; envelope é imutável no banco.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: DomainEventEnvelope,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | null,
    private _publishedAt: Date | null,
    private _lockedUntil: Date | null,
  ) {}

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | null {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | null {
    return this._publishedAt;
  }

  get lockedUntil(): Date | null {
    return this._lockedUntil;
  }

  get isPublished(): boolean {
    return this._publishedAt !== null;
  }

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
      null,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      toDate(state.occurredAt),
      state.attempts,
      state.nextAttemptAt === null || state.nextAttemptAt === undefined
        ? null
        : toDate(state.nextAttemptAt),
      state.publishedAt === null || state.publishedAt === undefined
        ? null
        : toDate(state.publishedAt),
      state.lockedUntil === null || state.lockedUntil === undefined
        ? null
        : toDate(state.lockedUntil),
    );
  }

  markPublished(at: Date = new Date()): void {
    this._publishedAt = at;
    this._lockedUntil = null;
    this._nextAttemptAt = null;
  }

  markPublishFailed(nextAttemptAt: Date): void {
    this._lockedUntil = null;
    this._nextAttemptAt = nextAttemptAt;
  }

  applyClaim(lockedUntil: Date, attempts: number): void {
    this._lockedUntil = lockedUntil;
    this._attempts = attempts;
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
