export class OutboxEventNotFoundError extends Error {
  constructor(public readonly eventId: string) {
    super(`Outbox event not found: ${eventId}`);
    this.name = 'OutboxEventNotFoundError';
  }
}

export class OutboxEventNotAwaitingInterventionError extends Error {
  constructor(public readonly eventId: string) {
    super(`Outbox event is not awaiting intervention: ${eventId}`);
    this.name = 'OutboxEventNotAwaitingInterventionError';
  }
}

export class OutboxEventAlreadyPublishedError extends Error {
  constructor(public readonly eventId: string) {
    super(`Outbox event already published (immutable): ${eventId}`);
    this.name = 'OutboxEventAlreadyPublishedError';
  }
}
