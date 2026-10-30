import { DataSource } from 'typeorm';
import { CreateWalletTable1761690000000 } from '../../src/infrastructure/database/migrations/001-Create_table_wallet';
import { CreateWagerTransactionTable1761690001000 } from '../../src/infrastructure/database/migrations/002-Create_table_wager_transaction';
import { CreateWalletLedgerEntryTable1761690002000 } from '../../src/infrastructure/database/migrations/003-Create_table_wallet_ledger_entry';
import { CreateOutboxMessageTable1761690003000 } from '../../src/infrastructure/database/migrations/004-Create_table_outbox_message';
import { AddFailureCodeToWagerTransaction1761690004000 } from '../../src/infrastructure/database/migrations/005-Add_failure_code_to_wager_transaction';
import { AddResultSnapshotToWagerTransaction1761690005000 } from '../../src/infrastructure/database/migrations/006-Add_result_snapshot_to_wager_transaction';
import { databaseEnv } from '../../src/infrastructure/database/env';

export const ALL_MIGRATIONS = [
  CreateWalletTable1761690000000,
  CreateWagerTransactionTable1761690001000,
  CreateWalletLedgerEntryTable1761690002000,
  CreateOutboxMessageTable1761690003000,
  AddFailureCodeToWagerTransaction1761690004000,
  AddResultSnapshotToWagerTransaction1761690005000,
] as const;

export function createMigrationDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: databaseEnv.host,
    port: databaseEnv.port,
    username: databaseEnv.username,
    password: databaseEnv.password,
    database: databaseEnv.database,
    synchronize: false,
    logging: false,
    migrations: [...ALL_MIGRATIONS],
    migrationsTableName: 'migrations',
  });
}
