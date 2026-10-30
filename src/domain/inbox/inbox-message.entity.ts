export type InboxMessageState = {
  id: string;
  eventType: string;
  transportMessageId: string | null;
  receivedAt: Date | string;
  processedAt: Date | string;
};

/**
 * Registro de mensagem já processada (deduplicação persistente).
 */
export class InboxMessage {
  private constructor(
    public readonly id: string,
    public readonly eventType: string,
    public readonly transportMessageId: string | null,
    public readonly receivedAt: Date,
    public readonly processedAt: Date,
  ) {}

  static record(input: {
    id: string;
    eventType: string;
    transportMessageId?: string | null;
    at?: Date;
  }): InboxMessage {
    const at = input.at ?? new Date();
    return new InboxMessage(
      input.id,
      input.eventType,
      input.transportMessageId ?? null,
      at,
      at,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.id,
      state.eventType,
      state.transportMessageId,
      toDate(state.receivedAt),
      toDate(state.processedAt),
    );
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
