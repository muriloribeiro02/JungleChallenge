import type { QueryRunner } from 'typeorm';
import { OutboxInterventionFields1793389000000 } from '../../src/infrastructure/database/migrations/1793389000000-OutboxInterventionFields';

describe('OutboxInterventionFields migration (unit)', () => {
  const migration = new OutboxInterventionFields1793389000000();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;
    return { queryRunner, queries };
  }

  it('up adiciona last_error, last_failed_at, intervention_required_at e índice', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.up(queryRunner);

    expect(queries[0]).toContain('last_error');
    expect(queries[0]).toContain('last_failed_at');
    expect(queries[0]).toContain('intervention_required_at');
    expect(queries[1]).toContain('IDX_outbox_message_claimable_intervention');
    expect(queries[1]).toContain('"intervention_required_at" IS NULL');
  });

  it('down remove somente índice e colunas novas', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.down(queryRunner);

    expect(queries[0]).toContain('IDX_outbox_message_claimable_intervention');
    expect(queries[1]).toContain('DROP COLUMN IF EXISTS "intervention_required_at"');
    expect(queries[1]).toContain('DROP COLUMN IF EXISTS "last_failed_at"');
    expect(queries[1]).toContain('DROP COLUMN IF EXISTS "last_error"');
  });
});
