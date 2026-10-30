import type { QueryRunner } from 'typeorm';
import { PendingReferenceTtlAndClaim1793380707372 } from '../../src/infrastructure/database/migrations/1793380707372-PendingReferenceTtlAndClaim';

describe('PendingReferenceTtlAndClaim migration (unit)', () => {
  const migration = new PendingReferenceTtlAndClaim1793380707372();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;
    return { queryRunner, queries };
  }

  it('up adiciona colunas TTL/claim e índice', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.up(queryRunner);
    expect(queries[0]).toContain('pending_reference_at');
    expect(queries[0]).toContain('pending_attempt_count');
    expect(queries[0]).toContain('next_attempt_at');
    expect(queries[0]).toContain('locked_until');
    expect(queries[1]).toContain(`"status" = 'PENDING_REFERENCE'`);
    expect(queries[2]).toContain('IDX_wager_transaction_pending_claimable');
  });

  it('down remove índice e colunas', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.down(queryRunner);
    expect(queries[0]).toContain(
      'DROP INDEX IF EXISTS "IDX_wager_transaction_pending_claimable"',
    );
    expect(queries[1]).toContain('DROP COLUMN IF EXISTS "pending_reference_at"');
  });
});
