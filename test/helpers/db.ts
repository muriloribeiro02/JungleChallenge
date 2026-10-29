import { randomUUID } from 'node:crypto';
import { Client, type QueryResult, type QueryResultRow } from 'pg';
import { databaseEnv } from '../../src/infrastructure/database/env';

export type WalletInsert = {
  id?: string;
  playerId?: string;
  currency?: string;
  balance?: string;
  version?: number;
};

export function createDbClient(): Client {
  return new Client({
    host: databaseEnv.host,
    port: databaseEnv.port,
    user: databaseEnv.username,
    password: databaseEnv.password,
    database: databaseEnv.database,
  });
}

export async function insertWallet(
  client: Client,
  input: WalletInsert = {},
): Promise<QueryResult<QueryResultRow>> {
  return client.query(
    `
      INSERT INTO wallet (id, player_id, currency, balance, version)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
    [
      input.id ?? randomUUID(),
      input.playerId ?? randomUUID(),
      input.currency ?? 'BRL',
      input.balance ?? '0.0000',
      input.version ?? 1,
    ],
  );
}
