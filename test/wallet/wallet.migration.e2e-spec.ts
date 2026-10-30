import type { DataSource } from 'typeorm';
import { createDbClient } from '../helpers/db';
import { createMigrationDataSource } from '../helpers/migration-data-source';

describe('wallet migrations (e2e ida e volta)', () => {
  let dataSource: DataSource;

  async function tableExists(tableName: string): Promise<boolean> {
    const client = createDbClient();
    await client.connect();
    try {
      const result = await client.query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = $1
          ) AS exists
        `,
        [tableName],
      );
      return result.rows[0].exists === true;
    } finally {
      await client.end();
    }
  }

  async function migrationIsRecorded(name: string): Promise<boolean> {
    const client = createDbClient();
    await client.connect();
    try {
      const result = await client.query(
        `SELECT 1 FROM migrations WHERE name = $1 LIMIT 1`,
        [name],
      );
      return (result.rowCount ?? 0) > 0;
    } finally {
      await client.end();
    }
  }

  async function getWalletColumns(): Promise<string[]> {
    const client = createDbClient();
    await client.connect();
    try {
      const result = await client.query(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'wallet'
          ORDER BY ordinal_position
        `,
      );
      return result.rows.map((row: { column_name: string }) => row.column_name);
    } finally {
      await client.end();
    }
  }

  async function undoUntilWalletRemoved(): Promise<void> {
    while (await tableExists('wallet')) {
      await dataSource.undoLastMigration();
    }
  }

  beforeAll(async () => {
    dataSource = createMigrationDataSource();
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.runMigrations();
      await dataSource.destroy();
    }
  });

  it('reverte dependentes e remove a tabela wallet', async () => {
    expect(await tableExists('wallet')).toBe(true);

    await undoUntilWalletRemoved();

    expect(await tableExists('wallet')).toBe(false);
    expect(await tableExists('wager_transaction')).toBe(false);
    expect(await tableExists('wallet_ledger_entry')).toBe(false);
    expect(await tableExists('outbox_message')).toBe(false);
    expect(
      await migrationIsRecorded('CreateWalletTable1761690000000'),
    ).toBe(false);
  });

  it('aplica de novo (up) e recria wallet e migrations financeiras', async () => {
    const applied = await dataSource.runMigrations();

    expect(applied.map((migration) => migration.name)).toEqual([
      'CreateWalletTable1761690000000',
      'CreateWagerTransactionTable1761690001000',
      'CreateWalletLedgerEntryTable1761690002000',
      'CreateOutboxMessageTable1761690003000',
      'AddFailureCodeToWagerTransaction1761690004000',
      'AddResultSnapshotToWagerTransaction1761690005000',
      'RefundRollbackPendingAndUniqueReversal1761690006000',
      'IndexPendingReferenceLookup1761690007000',
      'OutboxClaimLockedUntil1761690008000',
      'CreateInboxMessageTable1761690009000',
      'UniqueAnyProcessedReversalPerReference1761690010000',
    ]);
    expect(await tableExists('wallet')).toBe(true);
    expect(await tableExists('wager_transaction')).toBe(true);
    expect(await tableExists('wallet_ledger_entry')).toBe(true);
    expect(await tableExists('outbox_message')).toBe(true);
    expect(
      await migrationIsRecorded('CreateWalletTable1761690000000'),
    ).toBe(true);
    expect(await getWalletColumns()).toEqual([
      'id',
      'player_id',
      'currency',
      'balance',
      'version',
      'created_at',
      'updated_at',
    ]);
  });
});
