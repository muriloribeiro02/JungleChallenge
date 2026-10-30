import { randomUUID } from 'node:crypto';
import { createDbClient } from '../helpers/db';
import {
  MULTI_INSTANCE_BASES,
  assertBalanceEqualsLedger,
  cleanupWallets,
  createWallet,
  dockerCompose,
  fetchJson,
  roundRobinBase,
  sleep,
  submitBet,
  submitRefund,
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

  describe('Cenário E — PENDING_REFERENCE TTL multi-processo (C2)', () => {
    it('três workers reais: uma claim → um REJECTED + um WagerTransactionRejected', async () => {
      const wallet = await createWallet(MULTI_INSTANCE_BASES[0], '100.00');
      walletIds.push(wallet.id);
      const providerId = 'provider-multi-e-ttl';
      const missingRef = randomUUID();

      const refund = await submitRefund(MULTI_INSTANCE_BASES[1], {
        providerId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        amount: '10.00',
        idempotencyKey: `${providerId}:ttl-pending`,
        referenceExternalTransactionId: missingRef,
      });
      expect(refund.status).toBe(202);
      expect(refund.body.status).toBe('PENDING_REFERENCE');
      const pendingId = refund.body.transactionId as string;

      // Torna elegível em todas as instâncias ao mesmo tempo (TTL expirado
      // prevalece sobre next_attempt futuro). Workers app-1/2/3 competem via
      // FOR UPDATE SKIP LOCKED — não usamos Promise.all no mesmo processo.
      const client = createDbClient();
      await client.connect();
      try {
        await client.query(
          `
            UPDATE wager_transaction
            SET pending_reference_at = NOW() - INTERVAL '25 hours',
                next_attempt_at = NOW() + INTERVAL '30 minutes',
                locked_until = NULL,
                pending_attempt_count = 0
            WHERE id = $1
          `,
          [pendingId],
        );
      } finally {
        await client.end();
      }

      await waitUntil(async () => {
        const c = createDbClient();
        await c.connect();
        try {
          const row = await c.query(
            `SELECT status FROM wager_transaction WHERE id = $1`,
            [pendingId],
          );
          return row.rows[0]?.status === 'REJECTED';
        } finally {
          await c.end();
        }
      }, 60_000);

      const verify = createDbClient();
      await verify.connect();
      try {
        const tx = await verify.query(
          `
            SELECT status, failure_code, pending_attempt_count
            FROM wager_transaction WHERE id = $1
          `,
          [pendingId],
        );
        expect(tx.rows).toHaveLength(1);
        expect(tx.rows[0].status).toBe('REJECTED');
        expect(tx.rows[0].failure_code).toBe('REFERENCE_NOT_FOUND');

        const rejectedEvents = await verify.query(
          `
            SELECT id, event_type, payload
            FROM outbox_message
            WHERE aggregate_id = $1
              AND event_type = 'WagerTransactionRejected'
          `,
          [pendingId],
        );
        expect(rejectedEvents.rows).toHaveLength(1);
        expect(rejectedEvents.rows[0].payload.data.failureCode).toBe(
          'REFERENCE_NOT_FOUND',
        );

        const ledger = await verify.query(
          `SELECT COUNT(*)::int AS c FROM wallet_ledger_entry WHERE transaction_id = $1`,
          [pendingId],
        );
        expect(ledger.rows[0].c).toBe(0);

        const bal = await verify.query(
          `SELECT balance::text AS b FROM wallet WHERE id = $1`,
          [wallet.id],
        );
        expect(String(bal.rows[0].b)).toContain('100');
      } finally {
        await verify.end();
      }

      await assertBalanceEqualsLedger(wallet.id);
      await reconcileOk(wallet.id);
      // Três processos distintos estavam vivos (beforeAll); a unicidade
      // REJECTED/outbox prova que só um claim venceu entre eles.
      expect(lives.map((l) => l.instanceId).sort()).toEqual([
        'app-1',
        'app-2',
        'app-3',
      ]);
    }, 120_000);
  });

  describe('Cenário F — Graceful shutdown multi-processo (C3)', () => {
    afterEach(async () => {
      // Restaura app-1 sem probe de hold e sobe as três instâncias.
      await dockerCompose(
        ['up', '-d', '--no-deps', '--force-recreate', 'app-1'],
        {
          env: {
            ...process.env,
            SHUTDOWN_DRAIN_MS: '10000',
            SHUTDOWN_TEST_HOLD_MS: '0',
            OUTBOX_CLAIM_LEASE_SECONDS: '60',
          },
        },
      ).catch(() => undefined);
      await dockerCompose(['start', 'app-1', 'app-2', 'app-3']).catch(
        () => undefined,
      );
      lives = await waitForInstances(120_000);
    }, 180_000);

    it('H) SIGTERM em app-1 — app-2 e app-3 continuam aceitando apostas', async () => {
      await dockerCompose(['stop', 'app-1']);

      await waitUntil(async () => {
        try {
          const res = await fetch(`${MULTI_INSTANCE_BASES[0]}/health/live`);
          return !res.ok;
        } catch {
          return true;
        }
      }, 60_000);

      const live2 = await fetchJson<LiveInfo>(
        `${MULTI_INSTANCE_BASES[1]}/health/live`,
      );
      const live3 = await fetchJson<LiveInfo>(
        `${MULTI_INSTANCE_BASES[2]}/health/live`,
      );
      expect(live2.status).toBe(200);
      expect(live3.status).toBe(200);
      expect(live2.body.instanceId).toBe('app-2');
      expect(live3.body.instanceId).toBe('app-3');
      expect(live2.body.stopping).not.toBe(true);
      expect(live3.body.stopping).not.toBe(true);

      const wallet = await createWallet(MULTI_INSTANCE_BASES[1], '200.00');
      walletIds.push(wallet.id);

      const bet2 = await submitBet(MULTI_INSTANCE_BASES[1], {
        providerId: 'provider-multi-f-h',
        playerId: wallet.playerId,
        walletId: wallet.id,
        amount: '10.00',
        idempotencyKey: 'provider-multi-f-h:bet-2',
        externalTransactionId: 'bet-app2',
      });
      const bet3 = await submitBet(MULTI_INSTANCE_BASES[2], {
        providerId: 'provider-multi-f-h',
        playerId: wallet.playerId,
        walletId: wallet.id,
        amount: '15.00',
        idempotencyKey: 'provider-multi-f-h:bet-3',
        externalTransactionId: 'bet-app3',
      });

      expect(bet2.status).toBe(200);
      expect(bet3.status).toBe(200);
      expect(bet2.body.status).toBe('PROCESSED');
      expect(bet3.body.status).toBe('PROCESSED');
      await assertBalanceEqualsLedger(wallet.id);
    }, 180_000);

    it('G) reinício de app-1 — workers retomam e publicam outbox', async () => {
      const wallet = await createWallet(MULTI_INSTANCE_BASES[2], '150.00');
      walletIds.push(wallet.id);

      const bet = await submitBet(MULTI_INSTANCE_BASES[2], {
        providerId: 'provider-multi-f-g',
        playerId: wallet.playerId,
        walletId: wallet.id,
        amount: '20.00',
        idempotencyKey: 'provider-multi-f-g:seed',
        externalTransactionId: 'seed-restart',
      });
      expect(bet.body.status).toBe('PROCESSED');
      const txId = bet.body.transactionId as string;

      // Força re-publicação: simula claim abandonado após SIGTERM mid-flight.
      const client = createDbClient();
      await client.connect();
      try {
        await client.query(
          `
            UPDATE outbox_message
            SET published_at = NULL,
                locked_until = NULL,
                next_attempt_at = NOW() - INTERVAL '1 second'
            WHERE aggregate_id = $1 OR aggregate_id = $2
          `,
          [txId, wallet.id],
        );
      } finally {
        await client.end();
      }

      await dockerCompose(['stop', 'app-1']);
      await sleep(1500);
      await dockerCompose(['start', 'app-1']);
      lives = await waitForInstances(120_000);
      expect(lives.map((l) => l.instanceId).sort()).toEqual([
        'app-1',
        'app-2',
        'app-3',
      ]);

      await waitUntil(async () => {
        const c = createDbClient();
        await c.connect();
        try {
          const pending = await c.query(
            `
              SELECT COUNT(*)::int AS c
              FROM outbox_message
              WHERE (aggregate_id = $1 OR aggregate_id = $2)
                AND published_at IS NULL
            `,
            [txId, wallet.id],
          );
          return pending.rows[0].c === 0;
        } finally {
          await c.end();
        }
      }, 60_000);

      const betOn1 = await submitBet(MULTI_INSTANCE_BASES[0], {
        providerId: 'provider-multi-f-g',
        playerId: wallet.playerId,
        walletId: wallet.id,
        amount: '5.00',
        idempotencyKey: 'provider-multi-f-g:after-restart',
        externalTransactionId: 'after-restart',
      });
      expect(betOn1.status).toBe(200);
      expect(betOn1.body.status).toBe('PROCESSED');
      await assertBalanceEqualsLedger(wallet.id);
    }, 180_000);

    it('I) drain_timeout real: hold pós-claim → SIGTERM → lease/recovery + integridade', async () => {
      // app-1 com hold longo e drain curto (processo real no Compose).
      await dockerCompose(['stop', 'app-1']);
      await dockerCompose(
        ['up', '-d', '--no-deps', '--force-recreate', 'app-1'],
        {
          env: {
            ...process.env,
            SHUTDOWN_DRAIN_MS: '500',
            SHUTDOWN_TEST_HOLD_MS: '12000',
            OUTBOX_CLAIM_LEASE_SECONDS: '5',
            WORKER_OUTBOX_INTERVAL_MS: '200',
            WORKER_INBOX_INTERVAL_MS: '60000',
            WORKER_INBOUND_INTERVAL_MS: '60000',
            WORKER_PENDING_INTERVAL_MS: '60000',
          },
        },
      );

      await waitUntil(async () => {
        try {
          const res = await fetch(`${MULTI_INSTANCE_BASES[0]}/health/live`);
          if (!res.ok) return false;
          const body = (await res.json()) as LiveInfo;
          return body.instanceId === 'app-1';
        } catch {
          return false;
        }
      }, 90_000);

      const wallet = await createWallet(MULTI_INSTANCE_BASES[1], '180.00');
      walletIds.push(wallet.id);
      const bet = await submitBet(MULTI_INSTANCE_BASES[1], {
        providerId: 'provider-multi-f-i',
        playerId: wallet.playerId,
        walletId: wallet.id,
        amount: '12.00',
        idempotencyKey: 'provider-multi-f-i:drain',
        externalTransactionId: 'drain-hold',
      });
      expect(bet.body.status).toBe('PROCESSED');
      const txId = bet.body.transactionId as string;

      const client = createDbClient();
      await client.connect();
      try {
        await client.query(
          `
            UPDATE outbox_message
            SET published_at = NULL,
                locked_until = NULL,
                next_attempt_at = NOW() - INTERVAL '1 second',
                attempts = 0
            WHERE aggregate_id = $1 OR aggregate_id = $2
          `,
          [txId, wallet.id],
        );
      } finally {
        await client.end();
      }

      // Tempo para app-1 claimar e entrar no hold (SHUTDOWN_TEST_HOLD_MS).
      await sleep(2500);

      await dockerCompose(['stop', 'app-1']);

      const logs = await dockerCompose(['logs', 'app-1', '--tail', '80']);
      const combined = `${logs.stdout}\n${logs.stderr}`;
      expect(combined).toMatch(/shutdown\.drain_timeout/);
      expect(combined).toMatch(/drained=false/);

      // app-2/3 recuperam via lease da outbox (sem efeito financeiro duplicado).
      await waitUntil(async () => {
        const c = createDbClient();
        await c.connect();
        try {
          const pending = await c.query(
            `
              SELECT COUNT(*)::int AS c
              FROM outbox_message
              WHERE (aggregate_id = $1 OR aggregate_id = $2)
                AND published_at IS NULL
            `,
            [txId, wallet.id],
          );
          return pending.rows[0].c === 0;
        } finally {
          await c.end();
        }
      }, 90_000);

      const verify = createDbClient();
      await verify.connect();
      try {
        const bets = await verify.query(
          `
            SELECT COUNT(*)::int AS c
            FROM wager_transaction
            WHERE wallet_id = $1 AND kind = 'BET' AND status = 'PROCESSED'
          `,
          [wallet.id],
        );
        expect(bets.rows[0].c).toBe(1);

        const debits = await verify.query(
          `
            SELECT COUNT(*)::int AS c
            FROM wallet_ledger_entry
            WHERE wallet_id = $1 AND direction = 'DEBIT'
          `,
          [wallet.id],
        );
        expect(debits.rows[0].c).toBe(1);

        const dupOutbox = await verify.query(
          `
            SELECT id, COUNT(*)::int AS c
            FROM outbox_message
            WHERE aggregate_id = $1 OR aggregate_id = $2
            GROUP BY id
            HAVING COUNT(*) > 1
          `,
          [txId, wallet.id],
        );
        expect(dupOutbox.rows).toHaveLength(0);
      } finally {
        await verify.end();
      }

      await assertBalanceEqualsLedger(wallet.id);
      // app-1 ainda parado após SIGTERM — reconcilia via app-2.
      await reconcileOk(wallet.id, MULTI_INSTANCE_BASES[1]);

      const live2 = await fetchJson<LiveInfo>(
        `${MULTI_INSTANCE_BASES[1]}/health/live`,
      );
      const live3 = await fetchJson<LiveInfo>(
        `${MULTI_INSTANCE_BASES[2]}/health/live`,
      );
      expect(live2.status).toBe(200);
      expect(live3.status).toBe(200);
    }, 240_000);
  });
});

async function reconcileOk(
  walletId: string,
  base: string = MULTI_INSTANCE_BASES[0],
): Promise<void> {
  const { status, body } = await fetchJson<{ consistent: boolean }>(
    `${base}/wallets/${walletId}/reconciliation`,
    { method: 'POST' },
  );
  expect(status).toBe(200);
  expect(body.consistent).toBe(true);
}
