import 'reflect-metadata';
import { DataSource } from 'typeorm';
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
  entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  migrationsTableName: 'migrations',
});
