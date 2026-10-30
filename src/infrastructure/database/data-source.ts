import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { OutboxMessageOrmEntity } from '../repository/outbox/outbox-message.orm-entity';
import { WagerTransactionOrmEntity } from '../repository/wager-transaction/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from '../repository/wallet-ledger/wallet-ledger-entry.orm-entity';
import { WalletOrmEntity } from '../repository/wallet/wallet.orm-entity';
import { databaseEnv } from './env';

export default new DataSource({
  type: 'postgres',
  host: databaseEnv.host,
  port: databaseEnv.port,
  username: databaseEnv.username,
  password: databaseEnv.password,
  database: databaseEnv.database,
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
  entities: [
    WalletOrmEntity,
    WagerTransactionOrmEntity,
    WalletLedgerEntryOrmEntity,
    OutboxMessageOrmEntity,
  ],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  migrationsTableName: 'migrations',
});
