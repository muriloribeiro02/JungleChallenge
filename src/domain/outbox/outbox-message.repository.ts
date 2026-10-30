import type { OutboxMessage } from './outbox-message.entity';

export interface OutboxMessageRepository {
  save(message: OutboxMessage): Promise<void>;
  findByAggregateId(aggregateId: string): Promise<OutboxMessage[]>;
  findById(id: string): Promise<OutboxMessage | null>;
  /**
   * Reserva até `limit` mensagens não publicadas com FOR UPDATE SKIP LOCKED.
   * Incrementa attempts e define locked_until.
   */
  claimUnpublished(limit: number, leaseSeconds: number): Promise<OutboxMessage[]>;
  markPublished(id: string, publishedAt?: Date): Promise<void>;
  markPublishFailed(id: string, nextAttemptAt: Date): Promise<void>;
}

export const OUTBOX_MESSAGE_REPOSITORY = Symbol('OUTBOX_MESSAGE_REPOSITORY');
