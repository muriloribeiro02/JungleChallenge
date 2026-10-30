import type { QueryRunner } from 'typeorm';
import { CreateOutboxMessageTable1761690003000 } from '../../src/infrastructure/database/migrations/004-Create_table_outbox_message';

describe('CreateOutboxMessageTable migration (unit)', () => {
  const migration = new CreateOutboxMessageTable1761690003000();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    return { queryRunner, queries };
  }

  it('up cria outbox_message com payload jsonb e imutabilidade', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.up(queryRunner);

    expect(queries.some((sql) => sql.includes('CREATE TABLE "outbox_message"'))).toBe(
      true,
    );
    expect(queries.some((sql) => sql.includes('"payload"          jsonb'))).toBe(
      true,
    );
    expect(
      queries.some((sql) => sql.includes('IDX_outbox_message_unpublished')),
    ).toBe(true);
    expect(
      queries.some((sql) => sql.includes('trg_outbox_message_payload_immutable')),
    ).toBe(true);
  });

  it('down remove trigger, índices e tabela', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.down(queryRunner);

    expect(queries[0]).toContain(
      'DROP TRIGGER IF EXISTS trg_outbox_message_payload_immutable',
    );
    expect(queries.at(-1)).toContain('DROP TABLE IF EXISTS "outbox_message"');
  });
});
