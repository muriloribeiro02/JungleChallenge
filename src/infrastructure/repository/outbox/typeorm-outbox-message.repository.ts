import type { EntityManager, Repository } from 'typeorm';
import type { OutboxMessage } from '../../../domain/outbox/outbox-message.entity';
import type { OutboxMessageRepository } from '../../../domain/outbox/outbox-message.repository';
import { OutboxMessageMapper } from './outbox-message.mapper';
import { OutboxMessageOrmEntity } from './outbox-message.orm-entity';

export class TypeOrmOutboxMessageRepository
  implements OutboxMessageRepository
{
  constructor(
    private readonly messages: Repository<OutboxMessageOrmEntity>,
    private readonly manager?: EntityManager,
  ) {}

  async save(message: OutboxMessage): Promise<void> {
    await this.messages.save(OutboxMessageMapper.toPersistence(message));
  }

  async findByAggregateId(aggregateId: string): Promise<OutboxMessage[]> {
    const rows = await this.messages.find({ where: { aggregateId } });
    return rows.map((row) => OutboxMessageMapper.toDomain(row));
  }

  async findById(id: string): Promise<OutboxMessage | null> {
    const row = await this.messages.findOne({ where: { id } });
    return row ? OutboxMessageMapper.toDomain(row) : null;
  }

  async claimUnpublished(
    limit: number,
    leaseSeconds: number,
  ): Promise<OutboxMessage[]> {
    const em = this.manager ?? this.messages.manager;
    // TypeORM/pg devolve [rows, rowCount] em UPDATE … RETURNING
    const result: unknown = await em.query(
      `
        WITH cte AS (
          SELECT id
          FROM outbox_message
          WHERE published_at IS NULL
            AND (locked_until IS NULL OR locked_until < NOW())
            AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
          ORDER BY occurred_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE outbox_message AS o
        SET
          locked_until = NOW() + make_interval(secs => $2),
          attempts = o.attempts + 1
        FROM cte
        WHERE o.id = cte.id
        RETURNING
          o.id,
          o.aggregate_id AS "aggregateId",
          o.event_type AS "eventType",
          o.payload,
          o.occurred_at AS "occurredAt",
          o.attempts,
          o.next_attempt_at AS "nextAttemptAt",
          o.published_at AS "publishedAt",
          o.locked_until AS "lockedUntil"
      `,
      [limit, leaseSeconds],
    );

    const rows = unwrapReturningRows(result);

    return rows.map((row) =>
      OutboxMessageMapper.toDomain({
        id: row.id,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
        payload: row.payload,
        occurredAt: row.occurredAt,
        attempts: Number(row.attempts),
        nextAttemptAt: row.nextAttemptAt,
        publishedAt: row.publishedAt,
        lockedUntil: row.lockedUntil,
      } as OutboxMessageOrmEntity),
    );
  }

  async markPublished(id: string, publishedAt: Date = new Date()): Promise<void> {
    await this.messages
      .createQueryBuilder()
      .update(OutboxMessageOrmEntity)
      .set({
        publishedAt,
        lockedUntil: null,
        nextAttemptAt: null,
      })
      .where('id = :id', { id })
      .execute();
  }

  async markPublishFailed(id: string, nextAttemptAt: Date): Promise<void> {
    await this.messages
      .createQueryBuilder()
      .update(OutboxMessageOrmEntity)
      .set({
        lockedUntil: null,
        nextAttemptAt,
      })
      .where('id = :id', { id })
      .execute();
  }
}

/** Normaliza retorno de UPDATE…RETURNING (objeto[] | [objeto[], rowCount]). */
function unwrapReturningRows(result: unknown): OutboxMessageOrmEntity[] {
  if (!Array.isArray(result)) {
    return [];
  }
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as OutboxMessageOrmEntity[];
  }
  return result as OutboxMessageOrmEntity[];
}
