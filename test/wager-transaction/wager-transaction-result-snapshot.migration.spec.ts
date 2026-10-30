import type { QueryRunner } from 'typeorm';
import { AddResultSnapshotToWagerTransaction1761690005000 } from '../../src/infrastructure/database/migrations/006-Add_result_snapshot_to_wager_transaction';

describe('AddResultSnapshotToWagerTransaction migration (unit)', () => {
  const migration = new AddResultSnapshotToWagerTransaction1761690005000();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    return { queryRunner, queries };
  }

  it('up adiciona colunas nullable, backfill via ledger e CHECKs condicionais', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.up(queryRunner);

    expect(queries[0]).toContain('ADD COLUMN "observed_balance" numeric(19,4)');
    expect(queries[0]).toContain('ADD COLUMN "observed_wallet_version" integer');
    expect(queries[1]).toContain('SET "observed_balance" = l."balance_after"');
    expect(queries[1]).toContain(`t."status" = 'PROCESSED'`);
    expect(queries[1]).not.toContain('outbox');
    expect(queries[1]).not.toContain('observed_wallet_version');
    expect(queries[2]).toContain(
      'CHK_wager_transaction_observed_balance_non_negative',
    );
    expect(queries[3]).toContain(
      'CHK_wager_transaction_observed_wallet_version_positive',
    );
  });

  it('down remove CHECKs e colunas na ordem correta', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.down(queryRunner);

    expect(queries[0]).toContain(
      'CHK_wager_transaction_observed_wallet_version_positive',
    );
    expect(queries[1]).toContain(
      'CHK_wager_transaction_observed_balance_non_negative',
    );
    expect(queries[2]).toContain('DROP COLUMN IF EXISTS "observed_wallet_version"');
    expect(queries[2]).toContain('DROP COLUMN IF EXISTS "observed_balance"');
  });
});
