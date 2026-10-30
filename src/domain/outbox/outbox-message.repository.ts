import type { OutboxMessage } from './outbox-message.entity';

export interface OutboxMessageRepository {
  save(message: OutboxMessage): Promise<void>;
  findByAggregateId(aggregateId: string): Promise<OutboxMessage[]>;
}

export const OUTBOX_MESSAGE_REPOSITORY = Symbol('OUTBOX_MESSAGE_REPOSITORY');
