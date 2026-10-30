import { randomUUID } from 'node:crypto';
import { createDbClient } from '../helpers/db';
import {
  MULTI_INSTANCE_BASES,
  assertBalanceEqualsLedger,
  cleanupWallets,
  createWallet,
  fetchJson,
  roundRobinBase,
  submitBet,
  waitForInstances,
  waitUntil,
  type LiveInfo,
} from './helpers';

/**
 * Fase B — processos independentes (app-1/2/3 via Docker).
 * Não usa Promise.all como substituto de multi-instância: as requisições
 * HTTP vão para bases distintas; workers rodam em cada container.
 */
describe('Multi-instance (3 processos reais)', () => {
  const walletIds: string[] = [];
  let lives: LiveInfo[];

  beforeAll(async () => {
    lives = await waitForInstances();
  }, 180_000);

  afterEach(async () => {
    await cleanupWallets(walletIds.splice(0, walletIds.length));
  });

  it('evidência: 3 instâncias distintas com workers ativos', () => {
    expect(lives).toHaveLength(3);
    const ids = lives.map((l) => l.instanceId).sort();
    expect(ids).toEqual(['app-1', 'app-2', 'app-3']);
    expect(lives.every((l) => l.workersEnabled)).toBe(true);
    expect(new Set(MULTI_INSTANCE_BASES).size).toBe(3);
  });

  describe('Cenário A', () => {
    it('A1) 50 requisições simultâneas com a mesma Idempotency-Key → um débito', async () => {
      const wallet = await createWallet(MULTI_INSTANCE_BASES[0], '1000.00');
      walletIds.push(wallet.id);

      const providerId = 'provider-multi-a1';
      const idempotencyKey = `${providerId}:same-bet-50`;
      const externalTransactionId = 'same-bet-50';

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          submitBet(roundRobinBase(i), {
            providerId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            amount: '25.00',
            idempotencyKey,
            externalTransactionId,
          }),
        ),
      );

      const basesHit = new Set(results.map((r) => r.base));
      expect(basesHit.size).toBe(3);

      const bodies = results.map((r) => r.body);
      const transactionIds = new Set(
        bodies.map((b) => b.transactionId as string),
      );
      expect(transactionIds.size).toBe(1);

      const client = createDbClient();
      await client.connect();
      try {
        const bets = await client.query(
          `
            SELECT status, COUNT(*)::int AS c
            FROM wager_transaction
            WHERE wallet_id = $1 AND kind = 'BET'
            GROUP BY status
          `,
          [wallet.id],
        );
        const byStatus = Object.fromEntries(
          bets.rows.map((r: { status: string; c: number }) => [r.status, r.c]),
        );
        expect(byStatus.PROCESSED ?? 0).toBe(1);

        const debits = await client.query(
          `
            SELECT COUNT(*)::int AS c
            FROM wallet_ledger_entry
            WHERE wallet_id = $1 AND direction = 'DEBIT'
          `,
          [wallet.id],
        );
        // OPENING não gera DEBIT; só 1 BET
        expect(debits.rows[0].c).toBe(1);

        const bal = await client.query(
          `SELECT balance::text AS b FROM wallet WHERE id = $1`,
          [wallet.id],
        );
        expect(String(bal.rows[0].b)).toContain('975');
      } finally {
        await client.end();
      }

      await assertBalanceEqualsLedger(wallet.id);
      await reconcileOk(wallet.id);
    }, 120_000);

    it('A2) chaves distintas na mesma carteira — concorrência financeira', async () => {
      const wallet = await createWallet(MULTI_INSTANCE_BASES[1], '100.00');
      walletIds.push(wallet.id);
      const providerId = 'provider-multi-a2';

      // Duas BET de 80 disputando saldo 100 — exatamente uma PROCESSED
      const [r1, r2] = await Promise.all([
        submitBet(MULTI_INSTANCE_BASES[0], {
          providerId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          amount: '80.00',
          idempotencyKey: `${providerId}:race-a`,
          externalTransactionId: 'race-a',
        }),
        submitBet(MULTI_INSTANCE_BASES[2], {
          providerId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          amount: '80.00',
          idempotencyKey: `${providerId}:race-b`,
          externalTransactionId: 'race-b',
        }),
      ]);

      const statuses = [r1.body.status, r2.body.status].sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

      const client = createDbClient();
      await client.connect();
      try {
        const bal = await client.query(
          `SELECT balance::text AS b FROM wallet WHERE id = $1`,
          [wallet.id],
        );
        expect(String(bal.rows[0].b)).toContain('20');

        const debits = await client.query(
          `
            SELECT COUNT(*)::int AS c
            FROM wallet_ledger_entry
            WHERE wallet_id = $1 AND direction = 'DEBIT'
          `,
          [wallet.id],
        );
        expect(debits.rows[0].c).toBe(1);
      } finally {
        await client.end();
      }

      await assertBalanceEqualsLedger(wallet.id);
    }, 120_000);
  });

  describe('Cenário B — carteiras distintas em paralelo', () => {
    it('operações em wallets diferentes não se bloqueiam; ledgers consistentes', async () => {
      const wallets = await Promise.all(
        MULTI_INSTANCE_BASES.map((base) => createWallet(base, '500.00')),
      );
      for (const w of wallets) {
        walletIds.push(w.id);
      }

      const results = await Promise.all(
        wallets.flatMap((wallet, wi) =>
          Array.from({ length: 5 }, (_, j) =>
            submitBet(MULTI_INSTANCE_BASES[wi], {
              providerId: `provider-multi-b-${wi}`,
              playerId: wallet.playerId,
              walletId: wallet.id,
              amount: '10.00',
              idempotencyKey: `provider-multi-b-${wi}:bet-${j}`,
              externalTransactionId: `b-${wi}-${j}`,
            }),
          ),
        ),
      );

      expect(results.every((r) => r.body.status === 'PROCESSED')).toBe(true);

      for (const wallet of wallets) {
        const client = createDbClient();
        await client.connect();
        try {
          const bal = await client.query(
            `SELECT balance::text AS b FROM wallet WHERE id = $1`,
            [wallet.id],
          );
          expect(String(bal.rows[0].b)).toContain('450');
        } finally {
          await client.end();
        }
        await assertBalanceEqualsLedger(wallet.id);
      }
    }, 120_000);
  });

  describe('Cenário C — Outbox publishers multi-processo', () => {
    it('eventos publicados uma vez; lease expirado é recuperado', async () => {
      const wallet = await createWallet(MULTI_INSTANCE_BASES[0], '200.00');
      walletIds.push(wallet.id);
      const providerId = 'provider-multi-c';

      // Gera várias linhas de outbox via BETs
      for (let i = 0; i < 6; i += 1) {
        const res = await submitBet(roundRobinBase(i), {
          providerId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          amount: '5.00',
          idempotencyKey: `${providerId}:outbox-${i}`,
          externalTransactionId: `outbox-${i}`,
        });
        expect(res.body.status).toBe('PROCESSED');
      }

      await waitUntil(async () => {
        const client = createDbClient();
        await client.connect();
        try {
          const pending = await client.query(
            `
              SELECT COUNT(*)::int AS c
              FROM outbox_message
              WHERE aggregate_id IN (
                SELECT id FROM wager_transaction WHERE wallet_id = $1
              )
              AND published_at IS NULL
            `,
            [wallet.id],
          );
          return pending.rows[0].c === 0;
        } finally {
          await client.end();
        }
      }, 60_000);

      const client = createDbClient();
      await client.connect();
      try {
        const published = await client.query(
          `
            SELECT id, published_at, attempts
            FROM outbox_message
            WHERE aggregate_id IN (
              SELECT id FROM wager_transaction WHERE wallet_id = $1
            )
               OR aggregate_id = $1
          `,
          [wallet.id],
        );
        expect(published.rows.length).toBeGreaterThan(0);
        expect(
          published.rows.every(
            (r: { published_at: Date | null }) => r.published_at != null,
          ),
        ).toBe(true);

        // Simula claim abandonado: força lease no passado em uma mensagem
        // republicável (mark unpublished + locked_until antigo).
        const victim = published.rows[0];
        await client.query(
          `
            UPDATE outbox_message
            SET published_at = NULL,
                locked_until = NOW() - INTERVAL '5 minutes',
                next_attempt_at = NOW() - INTERVAL '1 minute'
            WHERE id = $1
          `,
          [victim.id],
        );
      } finally {
        await client.end();
      }

      await waitUntil(async () => {
        const c = createDbClient();
        await c.connect();
        try {
          const row = await c.query(
            `
              SELECT published_at
              FROM outbox_message
              WHERE aggregate_id IN (
                SELECT id FROM wager_transaction WHERE wallet_id = $1
              )
                 OR aggregate_id = $1
              ORDER BY occurred_at
              LIMIT 1
            `,
            [wallet.id],
          );
          // recovery: todas novamente publicadas
          const pending = await c.query(
            `
              SELECT COUNT(*)::int AS c
              FROM outbox_message
              WHERE (aggregate_id IN (
                SELECT id FROM wager_transaction WHERE wallet_id = $1
              ) OR aggregate_id = $1)
                AND published_at IS NULL
            `,
            [wallet.id],
          );
          return pending.rows[0].c === 0 && row.rows[0]?.published_at != null;
        } finally {
          await c.end();
        }
      }, 60_000);

      // Sem duplicar linha: ainda 1 row por event id
      const c2 = createDbClient();
      await c2.connect();
      try {
        const dup = await c2.query(
          `
            SELECT id, COUNT(*)::int AS c
            FROM outbox_message
            WHERE aggregate_id IN (
              SELECT id FROM wager_transaction WHERE wallet_id = $1
            )
               OR aggregate_id = $1
            GROUP BY id
            HAVING COUNT(*) > 1
          `,
          [wallet.id],
        );
        expect(dup.rows).toHaveLength(0);
      } finally {
        await c2.end();
      }

      await assertBalanceEqualsLedger(wallet.id);
    }, 180_000);
  });

  describe('Cenário D — idempotência entre instâncias', () => {
    it('mesma Idempotency-Key em instâncias diferentes → um efeito', async () => {
      const wallet = await createWallet(MULTI_INSTANCE_BASES[2], '300.00');
      walletIds.push(wallet.id);
      const providerId = 'provider-multi-d';
      const key = `${providerId}:cross-instance`;
      const externalTransactionId = 'cross-instance';

      const [a, b, c] = await Promise.all([
        submitBet(MULTI_INSTANCE_BASES[0], {
          providerId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          amount: '40.00',
          idempotencyKey: key,
          externalTransactionId,
        }),
        submitBet(MULTI_INSTANCE_BASES[1], {
          providerId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          amount: '40.00',
          idempotencyKey: key,
          externalTransactionId,
        }),
        submitBet(MULTI_INSTANCE_BASES[2], {
          providerId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          amount: '40.00',
          idempotencyKey: key,
          externalTransactionId,
        }),
      ]);

      expect(new Set([a.base, b.base, c.base]).size).toBe(3);
      const ids = [a, b, c].map((r) => r.body.transactionId);
      expect(new Set(ids).size).toBe(1);

      const client = createDbClient();
      await client.connect();
      try {
        const bets = await client.query(
          `
            SELECT COUNT(*)::int AS c
            FROM wager_transaction
            WHERE wallet_id = $1 AND kind = 'BET' AND status = 'PROCESSED'
          `,
          [wallet.id],
        );
        expect(bets.rows[0].c).toBe(1);

        const debits = await client.query(
          `
            SELECT COUNT(*)::int AS c
            FROM wallet_ledger_entry
            WHERE wallet_id = $1 AND direction = 'DEBIT'
          `,
          [wallet.id],
        );
        expect(debits.rows[0].c).toBe(1);

        const bal = await client.query(
          `SELECT balance::text AS b FROM wallet WHERE id = $1`,
          [wallet.id],
        );
        expect(String(bal.rows[0].b)).toContain('260');
      } finally {
        await client.end();
      }

      await assertBalanceEqualsLedger(wallet.id);
      await reconcileOk(wallet.id);
    }, 120_000);
  });
});

async function reconcileOk(walletId: string): Promise<void> {
  const base = MULTI_INSTANCE_BASES[0];
  const { status, body } = await fetchJson<{ consistent: boolean }>(
    `${base}/wallets/${walletId}/reconciliation`,
    { method: 'POST' },
  );
  expect(status).toBe(200);
  expect(body.consistent).toBe(true);
}
