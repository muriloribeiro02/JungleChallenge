import { DataSource } from 'typeorm';
import { CreateWalletTable1761690000000 } from '../../src/infrastructure/database/migrations/001-Create_table_wallet';
import { databaseEnv } from '../../src/infrastructure/database/env';

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
    migrations: [CreateWalletTable1761690000000],
    migrationsTableName: 'migrations',
  });
}
