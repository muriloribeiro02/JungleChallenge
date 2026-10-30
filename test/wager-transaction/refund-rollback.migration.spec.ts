import type { QueryRunner } from 'typeorm';
import { RefundRollbackPendingAndUniqueReversal1761690006000 } from '../../src/infrastructure/database/migrations/007-Refund_rollback_pending_and_unique_reversal';

describe('RefundRollbackPendingAndUniqueReversal migration (unit)', () => {
  const migration = new RefundRollbackPendingAndUniqueReversal1761690006000();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    return { queryRunner, queries };
  }

  it('up relaxa CHK de refs e cria UNIQUE parcial de reversão PROCESSED', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.up(queryRunner);

    expect(queries[0]).toContain(
      'DROP CONSTRAINT IF EXISTS "CHK_wager_transaction_refund_rollback_refs"',
    );
    expect(queries[1]).toContain('PENDING_REFERENCE');
    expect(queries[1]).toContain('"resolved_internal_reference" IS NULL');
    expect(queries[2]).toContain(
      'UQ_wager_transaction_refund_processed_ref',
    );
    expect(queries[2]).toContain(`"kind" = 'REFUND'`);
    expect(queries[3]).toContain(
      'UQ_wager_transaction_rollback_processed_ref',
    );
    expect(queries[3]).toContain(`"kind" = 'ROLLBACK'`);
  });

  it('down remove índices e restaura CHK antigo', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.down(queryRunner);

    expect(queries[0]).toContain(
      'UQ_wager_transaction_rollback_processed_ref',
    );
    expect(queries[1]).toContain('UQ_wager_transaction_refund_processed_ref');
    expect(queries[3]).toContain(
      '"resolved_internal_reference" IS NOT NULL',
    );
  });
});
