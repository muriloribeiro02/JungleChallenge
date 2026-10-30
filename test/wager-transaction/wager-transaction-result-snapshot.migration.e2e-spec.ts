import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
  createDbClient,
  insertLedgerEntry,
  insertWallet,
  insertWagerTransaction,
} from '../helpers/db';
import { createMigrationDataSource } from '../helpers/migration-data-source';
import { AddResultSnapshotToWagerTransaction1761690005000 } from '../../src/infrastructure/database/migrations/006-Add_result_snapshot_to_wager_transaction';
import { RefundRollbackPendingAndUniqueReversal1761690006000 } from '../../src/infrastructure/database/migrations/007-Refund_rollback_pending_and_unique_reversal';
import { IndexPendingReferenceLookup1761690007000 } from '../../src/infrastructure/database/migrations/008-Index_pending_reference_lookup';

describe('AddResultSnapshotToWagerTransaction migration (e2e)', () => {
  let dataSource: DataSource;
  const migrationName = new AddResultSnapshotToWagerTransaction1761690005000()
    .name;
  const migration007Name =
    new RefundRollbackPendingAndUniqueReversal1761690006000().name;
  const migration008Name = new IndexPendingReferenceLookup1761690007000().name;

  async function columnExists(columnName: string): Promise<boolean> {
    const client = createDbClient();
    await client.connect();
    try {
      const result = await client.query(
        `
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'wager_transaction'
            AND column_name = $1
        `,
        [columnName],
      );
      return (result.rowCount ?? 0) > 0;
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

  async function undoUntilSnapshotRemoved(): Promise<void> {
    while (await columnExists('observed_balance')) {
      await dataSource.undoLastMigration();
    }
  }

  it('up adiciona colunas nullable; down remove colunas; reaplicar restaura', async () => {
    expect(await columnExists('observed_balance')).toBe(true);
    expect(await columnExists('observed_wallet_version')).toBe(true);
    expect(await migrationIsRecorded(migrationName)).toBe(true);

    await undoUntilSnapshotRemoved();

    expect(await columnExists('observed_balance')).toBe(false);
    expect(await columnExists('observed_wallet_version')).toBe(false);
    expect(await migrationIsRecorded(migrationName)).toBe(false);
    expect(await migrationIsRecorded(migration007Name)).toBe(false);
    expect(await migrationIsRecorded(migration008Name)).toBe(false);

    const applied = await dataSource.runMigrations();
    expect(applied.map((m) => m.name)).toEqual([
      migrationName,
      migration007Name,
      migration008Name,
    ]);
    expect(await columnExists('observed_balance')).toBe(true);
    expect(await columnExists('observed_wallet_version')).toBe(true);
  });

  it('backfill preenche observed_balance só via ledger em PROCESSED; version permanece NULL', async () => {
    await undoUntilSnapshotRemoved();
    expect(await columnExists('observed_balance')).toBe(false);

    const client = createDbClient();
    await client.connect();

    const walletId = randomUUID();
    const processedId = randomUUID();
    const rejectedId = randomUUID();
    const playerId = randomUUID();

    try {
      await insertWallet(client, {
        id: walletId,
        playerId,
        balance: '100.0000',
      });

      await insertWagerTransaction(client, {
        id: processedId,
        walletId,
        playerId,
        kind: 'BET',
        status: 'PROCESSED',
        amount: '25.0000',
        currency: 'BRL',
        providerId: 'provider-snap',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        payloadHash: 'hash-processed',
        roundId: 'round-1',
        gameId: 'game-1',
      });

      await insertLedgerEntry(client, {
        walletId,
        transactionId: processedId,
        direction: 'DEBIT',
        amount: '25.0000',
        currency: 'BRL',
        balanceBefore: '100.0000',
        balanceAfter: '75.0000',
      });

      await insertWagerTransaction(client, {
        id: rejectedId,
        walletId,
        playerId,
        kind: 'BET',
        status: 'REJECTED',
        amount: '10.0000',
        currency: 'BRL',
        providerId: 'provider-snap',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        payloadHash: 'hash-rejected',
        roundId: 'round-2',
        gameId: 'game-1',
        failureCode: 'INSUFFICIENT_FUNDS',
      });

      await dataSource.runMigrations();

      const processed = await client.query(
        `
          SELECT observed_balance, observed_wallet_version
          FROM wager_transaction
          WHERE id = $1
        `,
        [processedId],
      );
      expect(processed.rows[0].observed_balance).toBe('75.0000');
      expect(processed.rows[0].observed_wallet_version).toBeNull();

      const rejected = await client.query(
        `
          SELECT observed_balance, observed_wallet_version
          FROM wager_transaction
          WHERE id = $1
        `,
        [rejectedId],
      );
      expect(rejected.rows[0].observed_balance).toBeNull();
      expect(rejected.rows[0].observed_wallet_version).toBeNull();
    } finally {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = 'replica'`);
      await client.query(
        `DELETE FROM wallet_ledger_entry WHERE wallet_id = $1`,
        [walletId],
      );
      await client.query(`DELETE FROM wager_transaction WHERE wallet_id = $1`, [
        walletId,
      ]);
      await client.query(`DELETE FROM wallet WHERE id = $1`, [walletId]);
      await client.query('COMMIT');
      await client.end();
    }
  });

  it('CHECK rejeita observed_balance negativo e observed_wallet_version < 1', async () => {
    const client = createDbClient();
    await client.connect();
    try {
      await client.query('BEGIN');
      const walletId = randomUUID();
      const playerId = randomUUID();
      await insertWallet(client, { id: walletId, playerId });

      const tx = await insertWagerTransaction(client, {
        walletId,
        playerId,
        kind: 'BET',
        status: 'PROCESSED',
        amount: '10.0000',
        currency: 'BRL',
        providerId: 'provider-check',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        payloadHash: 'hash-check',
        roundId: 'round-check',
        gameId: 'game-check',
      });
      const txId = tx.rows[0].id as string;

      await expect(
        client.query(
          `UPDATE wager_transaction SET observed_balance = -1 WHERE id = $1`,
          [txId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CHK_wager_transaction_observed_balance_non_negative',
      });

      await client.query('ROLLBACK');
      await client.query('BEGIN');

      const walletId2 = randomUUID();
      const playerId2 = randomUUID();
      await insertWallet(client, { id: walletId2, playerId: playerId2 });
      const again = await insertWagerTransaction(client, {
        walletId: walletId2,
        playerId: playerId2,
        kind: 'BET',
        status: 'PROCESSED',
        amount: '10.0000',
        currency: 'BRL',
        providerId: 'provider-check',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        payloadHash: 'hash-check-2',
        roundId: 'round-check-2',
        gameId: 'game-check',
      });

      await expect(
        client.query(
          `UPDATE wager_transaction SET observed_wallet_version = 0 WHERE id = $1`,
          [again.rows[0].id],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CHK_wager_transaction_observed_wallet_version_positive',
      });
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});

