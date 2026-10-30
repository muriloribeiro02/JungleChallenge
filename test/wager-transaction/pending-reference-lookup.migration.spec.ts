import type { QueryRunner } from 'typeorm';
import { IndexPendingReferenceLookup1761690007000 } from '../../src/infrastructure/database/migrations/008-Index_pending_reference_lookup';

describe('IndexPendingReferenceLookup migration (unit)', () => {
  const migration = new IndexPendingReferenceLookup1761690007000();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    return { queryRunner, queries };
  }

  it('up cria índice parcial de PENDING_REFERENCE', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.up(queryRunner);
    expect(queries[0]).toContain('IDX_wager_transaction_pending_reference');
    expect(queries[0]).toContain(`"status" = 'PENDING_REFERENCE'`);
  });

  it('down remove o índice', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.down(queryRunner);
    expect(queries[0]).toContain(
      'DROP INDEX IF EXISTS "IDX_wager_transaction_pending_reference"',
    );
  });
});
