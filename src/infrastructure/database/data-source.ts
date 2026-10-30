import 'reflect-metadata';
import { DataSource } from 'typeorm';
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
  entities: [WalletOrmEntity],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  migrationsTableName: 'migrations',
});
