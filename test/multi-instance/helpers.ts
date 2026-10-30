import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createDbClient } from '../helpers/db';

const execFileAsync = promisify(execFile);

/** Raiz do repo (cwd dos testes multi-instance). */
export const REPO_ROOT = process.cwd();

export async function dockerCompose(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('docker', ['compose', ...args], {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024,
    env: options?.env ?? process.env,
  });
}

export const MULTI_INSTANCE_BASES = [
  process.env.MULTI_INSTANCE_URL_1 ?? 'http://127.0.0.1:3001',
  process.env.MULTI_INSTANCE_URL_2 ?? 'http://127.0.0.1:3002',
  process.env.MULTI_INSTANCE_URL_3 ?? 'http://127.0.0.1:3003',
] as const;

export type LiveInfo = {
  status: string;
  instanceId: string;
  pid: number;
  workersEnabled: boolean;
  stopping?: boolean;
};

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T; base: string }> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T;
  const base = new URL(url).origin;
  return { status: response.status, body, base };
}

export async function waitForInstances(
  timeoutMs = 120_000,
): Promise<LiveInfo[]> {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < timeoutMs) {
    try {
      const lives = await Promise.all(
        MULTI_INSTANCE_BASES.map(async (base) => {
          const { status, body } = await fetchJson<LiveInfo>(
            `${base}/health/live`,
          );
          if (status !== 200) {
            throw new Error(`${base} live=${status}`);
          }
          return body;
        }),
      );

      const ready = await Promise.all(
        MULTI_INSTANCE_BASES.map(async (base) => {
          const res = await fetch(`${base}/health/ready`);
          return res.status === 200;
        }),
      );

      if (ready.every(Boolean)) {
        return lives;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1500);
  }

  throw new Error(
    `Instâncias multi-processo indisponíveis em ${MULTI_INSTANCE_BASES.join(', ')}. ` +
      `Suba com: docker compose up -d --build app-1 app-2 app-3. Último erro: ${String(lastError)}`,
  );
}

export function roundRobinBase(index: number): string {
  return MULTI_INSTANCE_BASES[index % MULTI_INSTANCE_BASES.length];
}

export async function createWallet(
  base: string,
  initialBalance: string,
): Promise<{ id: string; playerId: string }> {
  const playerId = randomUUID();
  const { status, body } = await fetchJson<{
    id: string;
    playerId: string;
  }>(`${base}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: initialBalance, currency: 'BRL' },
    }),
  });
  if (status !== 201) {
    throw new Error(`createWallet ${status}: ${JSON.stringify(body)}`);
  }
  return { id: body.id, playerId: body.playerId };
}

export async function submitBet(
  base: string,
  input: {
    providerId: string;
    playerId: string;
    walletId: string;
    amount: string;
    idempotencyKey: string;
    externalTransactionId?: string;
    roundId?: string;
  },
): Promise<{ status: number; body: Record<string, unknown>; base: string }> {
  const externalTransactionId =
    input.externalTransactionId ?? randomUUID();
  return fetchJson(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({
      providerId: input.providerId,
      externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId ?? 'round-multi',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: input.amount, currency: 'BRL' },
    }),
  });
}

export async function submitRefund(
  base: string,
  input: {
    providerId: string;
    playerId: string;
    walletId: string;
    amount: string;
    idempotencyKey: string;
    externalTransactionId?: string;
    referenceExternalTransactionId: string;
    roundId?: string;
  },
): Promise<{ status: number; body: Record<string, unknown>; base: string }> {
  const externalTransactionId =
    input.externalTransactionId ?? randomUUID();
  return fetchJson(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({
      providerId: input.providerId,
      externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId ?? 'round-multi',
      gameId: 'fortune-chimp',
      kind: 'REFUND',
      money: { amount: input.amount, currency: 'BRL' },
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    }),
  });
}

export async function assertBalanceEqualsLedger(
  walletId: string,
): Promise<{ stored: string; calculated: string }> {
  const client = createDbClient();
  await client.connect();
  try {
    const bal = await client.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [walletId],
    );
    const ledger = await client.query(
      `
        SELECT COALESCE(
          SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END),
          0
        )::text AS delta
        FROM wallet_ledger_entry
        WHERE wallet_id = $1
      `,
      [walletId],
    );
    const stored = String(bal.rows[0].balance);
    const calculated = String(ledger.rows[0].delta);
    if (
      Math.abs(Number.parseFloat(stored) - Number.parseFloat(calculated)) >
      0.001
    ) {
      throw new Error(
        `ledger diverge wallet=${walletId} stored=${stored} calculated=${calculated}`,
      );
    }
    return { stored, calculated };
  } finally {
    await client.end();
  }
}

export async function cleanupWallets(walletIds: string[]): Promise<void> {
  if (walletIds.length === 0) {
    return;
  }
  const client = createDbClient();
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = 'replica'`);
    await client.query(
      `
        DELETE FROM inbox_message
        WHERE id IN (
          SELECT id::text FROM outbox_message
          WHERE aggregate_id = ANY($1::uuid[])
             OR aggregate_id IN (
               SELECT id FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])
             )
        )
      `,
      [walletIds],
    );
    await client.query(
      `
        DELETE FROM outbox_message
        WHERE aggregate_id = ANY($1::uuid[])
           OR aggregate_id IN (
             SELECT id FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])
           )
      `,
      [walletIds],
    );
    await client.query(
      `DELETE FROM wallet_ledger_entry WHERE wallet_id = ANY($1::uuid[])`,
      [walletIds],
    );
    await client.query(
      `DELETE FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])`,
      [walletIds],
    );
    await client.query(`DELETE FROM wallet WHERE id = ANY($1::uuid[])`, [
      walletIds,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = 400,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(stepMs);
  }
  throw new Error(`timeout waitUntil após ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
