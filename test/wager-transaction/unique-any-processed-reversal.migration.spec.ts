import type { QueryRunner } from 'typeorm';
import { UniqueAnyProcessedReversalPerReference1761690010000 } from '../../src/infrastructure/database/migrations/011-Unique_any_processed_reversal_per_reference';

describe('UniqueAnyProcessedReversalPerReference migration (unit)', () => {
  const migration = new UniqueAnyProcessedReversalPerReference1761690010000();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    return { queryRunner, queries };
  }

  it('up remove índices por kind e cria UNIQUE cross-kind', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.up(queryRunner);

    expect(queries[0]).toContain('UQ_wager_transaction_refund_processed_ref');
    expect(queries[1]).toContain('UQ_wager_transaction_rollback_processed_ref');
    expect(queries[2]).toContain('UQ_wager_transaction_processed_reversal_ref');
    expect(queries[2]).toContain(`"kind" IN ('REFUND', 'ROLLBACK')`);
    expect(queries[2]).toContain(`"status" = 'PROCESSED'`);
  });

  it('down restaura índices por kind da 007', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.down(queryRunner);

    expect(queries[0]).toContain('UQ_wager_transaction_processed_reversal_ref');
    expect(queries[1]).toContain('UQ_wager_transaction_refund_processed_ref');
    expect(queries[1]).toContain(`"kind" = 'REFUND'`);
    expect(queries[2]).toContain('UQ_wager_transaction_rollback_processed_ref');
    expect(queries[2]).toContain(`"kind" = 'ROLLBACK'`);
  });
});
