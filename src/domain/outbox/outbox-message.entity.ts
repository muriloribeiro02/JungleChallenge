import type { DomainEventEnvelope } from '../events/domain-event';

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
  lastError: string | null;
  lastFailedAt: Date | string | null;
  interventionRequiredAt: Date | string | null;
};

/**
 * Mensagem de outbox pronta para persistência (payload = envelope versionado).
 * Campos operacionais são mutáveis; envelope é imutável no banco.
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
    private _lastError: string | null,
    private _lastFailedAt: Date | null,
    private _interventionRequiredAt: Date | null,
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

  get lastError(): string | null {
    return this._lastError;
  }

  get lastFailedAt(): Date | null {
    return this._lastFailedAt;
  }

  get interventionRequiredAt(): Date | null {
    return this._interventionRequiredAt;
  }

  get isPublished(): boolean {
    return this._publishedAt !== null;
  }

  get requiresIntervention(): boolean {
    return this._interventionRequiredAt !== null;
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
      nullableDate(state.nextAttemptAt),
      nullableDate(state.publishedAt),
      nullableDate(state.lockedUntil),
      state.lastError ?? null,
      nullableDate(state.lastFailedAt),
      nullableDate(state.interventionRequiredAt),
    );
  }

  markPublished(at: Date = new Date()): void {
    this._publishedAt = at;
    this._lockedUntil = null;
    this._nextAttemptAt = null;
  }

  markPublishFailed(nextAttemptAt: Date, lastError: string, at: Date = new Date()): void {
    this._lockedUntil = null;
    this._nextAttemptAt = nextAttemptAt;
    this._lastError = lastError;
    this._lastFailedAt = at;
  }

  markInterventionRequired(lastError: string, at: Date = new Date()): void {
    this._lockedUntil = null;
    this._lastError = lastError;
    this._lastFailedAt = at;
    this._interventionRequiredAt = at;
  }

  clearIntervention(at: Date = new Date()): void {
    this._interventionRequiredAt = null;
    this._nextAttemptAt = at;
    this._lockedUntil = null;
  }

  applyClaim(lockedUntil: Date, attempts: number): void {
    this._lockedUntil = lockedUntil;
    this._attempts = attempts;
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function nullableDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toDate(value);
}
