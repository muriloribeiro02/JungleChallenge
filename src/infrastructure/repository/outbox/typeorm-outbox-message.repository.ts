import type { Repository } from 'typeorm';
import type { OutboxMessage } from '../../../domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../../domain/outbox/outbox-message.repository';
import { OutboxMessageMapper } from './outbox-message.mapper';
import { OutboxMessageOrmEntity } from './outbox-message.orm-entity';

export class TypeOrmOutboxMessageRepository
  implements OutboxMessageRepository
{
  constructor(
    private readonly messages: Repository<OutboxMessageOrmEntity>,
  ) {}

  async save(message: OutboxMessage): Promise<void> {
    await this.messages.save(OutboxMessageMapper.toPersistence(message));
  }

  async findByAggregateId(aggregateId: string): Promise<OutboxMessage[]> {
    const rows = await this.messages.find({ where: { aggregateId } });
    return rows.map((row) => OutboxMessageMapper.toDomain(row));
  }
}
