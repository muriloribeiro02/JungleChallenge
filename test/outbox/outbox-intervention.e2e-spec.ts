import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { OutboxPublisher } from '../../src/application/messaging/outbox-publisher';
import type { MessageBus } from '../../src/application/ports/message-bus';
import { ClearOutboxInterventionUseCase } from '../../src/application/use-cases/outbox/clear-outbox-intervention.use-case';
import dataSource from '../../src/infrastructure/database/data-source';
import { ConsoleMessagingLogger } from '../../src/infrastructure/logging/console-messaging-logger';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';
import { OutboxInterventionFields1793389000000 } from '../../src/infrastructure/database/migrations/1793389000000-OutboxInterventionFields';
import { createMigrationDataSource } from '../helpers/migration-data-source';

const logger = new ConsoleMessagingLogger();

function failingBus(): MessageBus {
  return {
    publish: async () => {
      throw new Error('forced-publish-fail token=secret-value');
    },
    receive: async () => [],
    ack: async () => undefined,
  };
}

function okBus(): MessageBus {
  return {
    publish: async () => undefined,
    receive: async () => [],
    ack: async () => undefined,
  };
}

async function insertEvent(
  connection: DataSource,
  overrides: {
    attempts?: number;
    interventionRequiredAt?: Date | null;
    publishedAt?: Date | null;
    lockedUntil?: Date | null;
    nextAttemptAt?: Date | null;
    payload?: Record<string, unknown>;
  } = {},
): Promise<{ id: string; payload: Record<string, unknown> }> {
  const id = randomUUID();
  const payload = overrides.payload ?? {
    eventId: id,
    eventType: 'WagerTransactionProcessed',
    aggregateId: randomUUID(),
    correlationId: randomUUID(),
    occurredAt: new Date().toISOString(),
    version: 1,
    data: { tag: 'intervention-e2e' },
  };

  await connection.query(
    `
      INSERT INTO outbox_message (
        id, aggregate_id, event_type, payload, occurred_at,
        attempts, next_attempt_at, published_at, locked_until,
        intervention_required_at
      )
      VALUES ($1, $2, $3, $4::jsonb, NOW(), $5, $6, $7, $8, $9)
    `,
    [
      id,
      payload.aggregateId,
      'WagerTransactionProcessed',
      JSON.stringify(payload),
      overrides.attempts ?? 0,
      overrides.nextAttemptAt ?? null,
      overrides.publishedAt ?? null,
      overrides.lockedUntil ?? null,
      overrides.interventionRequiredAt ?? null,
    ],
  );

  return { id, payload };
}

describe('Outbox intervention policy (e2e)', () => {
  let connection: DataSource;

  beforeAll(async () => {
    connection = dataSource;
    if (!connection.isInitialized) {
      await connection.initialize();
    }
    await connection.runMigrations();
  }, 60_000);

  afterAll(async () => {
    if (connection?.isInitialized) {
      await connection.destroy();
    }
  });

  beforeEach(async () => {
    await connection.query(
      `UPDATE outbox_message
       SET published_at = COALESCE(published_at, NOW()), locked_until = NULL
       WHERE published_at IS NULL`,
    );
  });

  it('evento com menos de 10 attempts continua elegível após falha', async () => {
    const { id } = await insertEvent(connection, { attempts: 3 });
    const uow = new TypeOrmUnitOfWork(connection);
    const publisher = new OutboxPublisher(
      uow,
      failingBus(),
      logger,
      { batchSize: 10, leaseSeconds: 5 },
    );

    const result = await publisher.publishBatch();
    expect(result.failed).toBeGreaterThan(0);

    const row = await connection.query(
      `SELECT attempts, intervention_required_at, last_error, published_at, locked_until
       FROM outbox_message WHERE id = $1`,
      [id],
    );
    expect(row[0].intervention_required_at).toBeNull();
    expect(row[0].published_at).toBeNull();
    expect(row[0].locked_until).toBeNull();
    expect(Number(row[0].attempts)).toBe(4);
    expect(String(row[0].last_error)).not.toContain('secret-value');

    await connection.query(
      `UPDATE outbox_message SET next_attempt_at = NOW() - interval '1 second' WHERE id = $1`,
      [id],
    );

    const claimed = await uow.run((repos) =>
      repos.outboxMessages.claimUnpublished(5, 5),
    );
    expect(claimed.some((m) => m.id === id)).toBe(true);
  });

  it('atinge 10 attempts, pausa, não é reclamado e transição é única', async () => {
    const { id } = await insertEvent(connection, { attempts: 9 });
    const uow = new TypeOrmUnitOfWork(connection);
    const publisher = new OutboxPublisher(
      uow,
      failingBus(),
      logger,
      { batchSize: 10, leaseSeconds: 5 },
    );

    const first = await publisher.publishBatch();
    expect(first.failed).toBeGreaterThan(0);

    const after = await connection.query(
      `SELECT attempts, intervention_required_at, last_failed_at, last_error, locked_until, published_at
       FROM outbox_message WHERE id = $1`,
      [id],
    );
    expect(Number(after[0].attempts)).toBe(10);
    expect(after[0].intervention_required_at).not.toBeNull();
    expect(after[0].last_failed_at).not.toBeNull();
    expect(after[0].locked_until).toBeNull();
    expect(after[0].published_at).toBeNull();

    const interventionAt = after[0].intervention_required_at;

    const second = await publisher.publishBatch();
    expect(second.claimed).toBe(0);

    const claimedElsewhere = await uow.run((repos) =>
      repos.outboxMessages.claimUnpublished(20, 5),
    );
    expect(claimedElsewhere.some((m) => m.id === id)).toBe(false);

    const again = await connection.query(
      `SELECT intervention_required_at FROM outbox_message WHERE id = $1`,
      [id],
    );
    expect(again[0].intervention_required_at).toEqual(interventionAt);

    const concurrent = await Promise.all([
      uow.run((repos) =>
        repos.outboxMessages.markInterventionRequired(id, 'dup-a'),
      ),
      uow.run((repos) =>
        repos.outboxMessages.markInterventionRequired(id, 'dup-b'),
      ),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(0);
  });

  it('recuperação manual preserva payload/eventId/attempts e reabilita claim', async () => {
    const { id, payload } = await insertEvent(connection, {
      attempts: 10,
      interventionRequiredAt: new Date(),
    });
    const uow = new TypeOrmUnitOfWork(connection);
    const clearer = new ClearOutboxInterventionUseCase(uow, logger);

    const result = await clearer.execute({ eventId: id });
    expect(result.attempts).toBe(10);
    expect(result.eventId).toBe(id);

    const row = await connection.query(
      `SELECT attempts, intervention_required_at, payload, next_attempt_at, published_at
       FROM outbox_message WHERE id = $1`,
      [id],
    );
    expect(row[0].intervention_required_at).toBeNull();
    expect(Number(row[0].attempts)).toBe(10);
    expect(row[0].payload.eventId).toBe(payload.eventId);
    expect(row[0].payload.data).toEqual(payload.data);
    expect(row[0].published_at).toBeNull();
    expect(row[0].next_attempt_at).not.toBeNull();

    const publisher = new OutboxPublisher(
      uow,
      okBus(),
      logger,
      { batchSize: 10, leaseSeconds: 5 },
    );
    const published = await publisher.publishBatch();
    expect(published.published).toBeGreaterThan(0);

    const finalRow = await connection.query(
      `SELECT published_at, attempts, payload FROM outbox_message WHERE id = $1`,
      [id],
    );
    expect(finalRow[0].published_at).not.toBeNull();
    expect(Number(finalRow[0].attempts)).toBeGreaterThanOrEqual(10);
    expect(finalRow[0].payload.eventId).toBe(payload.eventId);
  });

  it('eventos publicados permanecem imutáveis no payload', async () => {
    const { id } = await insertEvent(connection, {
      attempts: 2,
      publishedAt: new Date(),
    });

    await expect(
      connection.query(
        `UPDATE outbox_message SET payload = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ eventId: id, mutated: true }), id],
      ),
    ).rejects.toMatchObject({ code: 'P0001' });

    const claimed = await new TypeOrmUnitOfWork(connection).run((repos) =>
      repos.outboxMessages.claimUnpublished(50, 5),
    );
    expect(claimed.some((m) => m.id === id)).toBe(false);
  });

  it('múltiplas instâncias não reclamam o mesmo evento (SKIP LOCKED)', async () => {
    const { id } = await insertEvent(connection, { attempts: 0 });
    const uow = new TypeOrmUnitOfWork(connection);

    const [a, b, c] = await Promise.all([
      uow.run((repos) => repos.outboxMessages.claimUnpublished(1, 30)),
      uow.run((repos) => repos.outboxMessages.claimUnpublished(1, 30)),
      uow.run((repos) => repos.outboxMessages.claimUnpublished(1, 30)),
    ]);

    const ids = [...a, ...b, ...c].map((m) => m.id);
    expect(ids.filter((x) => x === id)).toHaveLength(1);
  });

  it('lease expirado permite recuperação após crash/shutdown', async () => {
    const { id } = await insertEvent(connection, {
      attempts: 2,
      lockedUntil: new Date(Date.now() - 5_000),
    });
    const uow = new TypeOrmUnitOfWork(connection);
    const claimed = await uow.run((repos) =>
      repos.outboxMessages.claimUnpublished(5, 10),
    );
    expect(claimed.some((m) => m.id === id)).toBe(true);
  });
});

describe('OutboxInterventionFields migration up/down (e2e)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = createMigrationDataSource();
    await ds.initialize();
    await ds.runMigrations();
  }, 120_000);

  afterAll(async () => {
    if (ds?.isInitialized) {
      await ds.destroy();
    }
  });

  it('revert remove colunas; up recria preservando linhas existentes', async () => {
    const id = randomUUID();
    await ds.query(
      `
        INSERT INTO outbox_message (
          id, aggregate_id, event_type, payload, occurred_at, attempts
        ) VALUES ($1, $2, 'WagerTransactionProcessed', $3::jsonb, NOW(), 1)
      `,
      [
        id,
        randomUUID(),
        JSON.stringify({
          eventId: id,
          eventType: 'WagerTransactionProcessed',
          aggregateId: randomUUID(),
          correlationId: randomUUID(),
          occurredAt: new Date().toISOString(),
          version: 1,
          data: {},
        }),
      ],
    );

    await ds.query(
      `UPDATE outbox_message
       SET last_error = 'x', last_failed_at = NOW(), intervention_required_at = NOW()
       WHERE id = $1`,
      [id],
    );

    await ds.undoLastMigration();

    const colsDown = await ds.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'outbox_message'
         AND column_name IN ('last_error','last_failed_at','intervention_required_at')`,
    );
    expect(colsDown).toHaveLength(0);

    const surviving = await ds.query(
      `SELECT id FROM outbox_message WHERE id = $1`,
      [id],
    );
    expect(surviving).toHaveLength(1);

    const applied = await ds.runMigrations();
    expect(applied.map((m) => m.name)).toContain(
      new OutboxInterventionFields1793389000000().name,
    );

    const colsUp = await ds.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'outbox_message'
         AND column_name IN ('last_error','last_failed_at','intervention_required_at')
       ORDER BY column_name`,
    );
    expect(colsUp.map((c: { column_name: string }) => c.column_name)).toEqual([
      'intervention_required_at',
      'last_error',
      'last_failed_at',
    ]);

    const after = await ds.query(
      `SELECT last_error, intervention_required_at FROM outbox_message WHERE id = $1`,
      [id],
    );
    expect(after[0].last_error).toBeNull();
    expect(after[0].intervention_required_at).toBeNull();
  });
});
