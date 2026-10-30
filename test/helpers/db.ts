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

export type WagerTransactionInsert = {
  id?: string;
  walletId: string;
  playerId?: string | null;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  providerId?: string | null;
  externalTransactionId?: string | null;
  idempotencyKey?: string | null;
  payloadHash?: string | null;
  roundId?: string | null;
  gameId?: string | null;
  externalReference?: string | null;
  resolvedInternalReference?: string | null;
  failureCode?: string | null;
};

export async function insertWagerTransaction(
  client: Client,
  input: WagerTransactionInsert,
): Promise<QueryResult<QueryResultRow>> {
  return client.query(
    `
      INSERT INTO wager_transaction (
        id, wallet_id, player_id, kind, status, amount, currency,
        provider_id, external_transaction_id, idempotency_key, payload_hash,
        round_id, game_id, external_reference, resolved_internal_reference,
        failure_code
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16
      )
      RETURNING *
    `,
    [
      input.id ?? randomUUID(),
      input.walletId,
      input.playerId ?? null,
      input.kind,
      input.status,
      input.amount,
      input.currency,
      input.providerId ?? null,
      input.externalTransactionId ?? null,
      input.idempotencyKey ?? null,
      input.payloadHash ?? null,
      input.roundId ?? null,
      input.gameId ?? null,
      input.externalReference ?? null,
      input.resolvedInternalReference ?? null,
      input.failureCode ?? null,
    ],
  );
}

export type ExternalWagerDefaults = {
  walletId: string;
  playerId: string;
  currency?: string;
  kind?: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  status?: string;
  amount?: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  roundId?: string;
  gameId?: string;
  externalReference?: string | null;
  resolvedInternalReference?: string | null;
  failureCode?: string | null;
  id?: string;
};

export async function insertExternalWagerTransaction(
  client: Client,
  input: ExternalWagerDefaults,
): Promise<QueryResult<QueryResultRow>> {
  const kind = input.kind ?? 'BET';
  const amount =
    input.amount ?? (kind === 'LOSS' ? '0.0000' : '10.0000');
  const status = input.status ?? 'PENDING';
  const failureCode =
    input.failureCode ??
    (status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : null);

  return insertWagerTransaction(client, {
    id: input.id,
    walletId: input.walletId,
    playerId: input.playerId,
    kind,
    status,
    amount,
    currency: input.currency ?? 'BRL',
    providerId: input.providerId ?? 'provider-a',
    externalTransactionId: input.externalTransactionId ?? randomUUID(),
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    payloadHash: input.payloadHash ?? 'hash-abc',
    roundId: input.roundId ?? 'round-1',
    gameId: input.gameId ?? 'game-1',
    externalReference: input.externalReference ?? null,
    resolvedInternalReference: input.resolvedInternalReference ?? null,
    failureCode,
  });
}

export type LedgerInsert = {
  id?: string;
  walletId: string;
  transactionId: string;
  direction?: 'CREDIT' | 'DEBIT';
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
};

export async function insertLedgerEntry(
  client: Client,
  input: LedgerInsert,
): Promise<QueryResult<QueryResultRow>> {
  return client.query(
    `
      INSERT INTO wallet_ledger_entry (
        id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
    [
      input.id ?? randomUUID(),
      input.walletId,
      input.transactionId,
      input.direction ?? 'CREDIT',
      input.amount,
      input.currency,
      input.balanceBefore,
      input.balanceAfter,
    ],
  );
}

export type OutboxInsert = {
  id?: string;
  aggregateId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
  attempts?: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
};

export async function insertOutboxMessage(
  client: Client,
  input: OutboxInsert = {},
): Promise<QueryResult<QueryResultRow>> {
  return client.query(
    `
      INSERT INTO outbox_message (
        id, aggregate_id, event_type, payload, occurred_at,
        attempts, next_attempt_at, published_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
      RETURNING *
    `,
    [
      input.id ?? randomUUID(),
      input.aggregateId ?? randomUUID(),
      input.eventType ?? 'WagerTransactionProcessed',
      JSON.stringify(
        input.payload ?? {
          version: 1,
          type: 'WagerTransactionProcessed',
          data: {},
        },
      ),
      input.occurredAt ?? new Date(),
      input.attempts ?? 0,
      input.nextAttemptAt ?? null,
      input.publishedAt ?? null,
    ],
  );
}
