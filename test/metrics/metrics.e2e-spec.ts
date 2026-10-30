import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import dataSource from '../../src/infrastructure/database/data-source';

describe('GET /metrics (e2e)', () => {
  let app: INestApplication;
  const createdWalletIds: string[] = [];

  beforeAll(async () => {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
    await dataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.init();
  }, 60_000);

  afterEach(async () => {
    if (createdWalletIds.length === 0) {
      return;
    }
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SET LOCAL session_replication_role = 'replica'`);
      await qr.query(
        `DELETE FROM outbox_message WHERE aggregate_id = ANY($1::uuid[])
           OR aggregate_id IN (SELECT id FROM wager_transaction WHERE wallet_id = ANY($1::uuid[]))`,
        [createdWalletIds],
      );
      await qr.query(
        `DELETE FROM wallet_ledger_entry WHERE wallet_id = ANY($1::uuid[])`,
        [createdWalletIds],
      );
      await qr.query(
        `DELETE FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])`,
        [createdWalletIds],
      );
      await qr.query(`DELETE FROM wallet WHERE id = ANY($1::uuid[])`, [
        createdWalletIds,
      ]);
      await qr.commitTransaction();
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
      createdWalletIds.length = 0;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('expõe texto Prometheus sem auth e sem dados financeiros sensíveis', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('# HELP');
    expect(res.text).toContain('dwp_outbox_pending_events');
    expect(res.text).toContain('dwp_outbox_intervention_required_events');
    expect(res.text).toContain('dwp_outbox_high_attempt_events');

    expect(res.text).not.toMatch(/"amount"|balance\.amount|playerId=/);
  });

  it('incrementa métricas de BET após submit sem alterar saldo esperado', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    createdWalletIds.push(wallet.body.id);

    const before = await request(app.getHttpServer()).get('/metrics');
    const beforeCount = metricValue(
      before.text,
      'dwp_wager_transactions_total',
      { kind: 'BET', status: 'PROCESSED' },
    );

    const bet = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `metrics-e2e:${randomUUID()}`)
      .send({
        providerId: 'provider-metrics',
        externalTransactionId: `tx-${randomUUID()}`,
        playerId,
        walletId: wallet.body.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      })
      .expect(200);

    expect(bet.body.status).toBe('PROCESSED');
    expect(bet.body.balance.amount).toBe('90.00');

    const after = await request(app.getHttpServer()).get('/metrics');
    const afterCount = metricValue(
      after.text,
      'dwp_wager_transactions_total',
      { kind: 'BET', status: 'PROCESSED' },
    );
    expect(afterCount).toBe(beforeCount + 1);

    const reconcile = await request(app.getHttpServer())
      .post(`/wallets/${wallet.body.id}/reconciliation`)
      .expect(200);
    expect(reconcile.body.consistent).toBe(true);

    const metricsAfterReconcile = await request(app.getHttpServer()).get(
      '/metrics',
    );
    expect(metricsAfterReconcile.text).toContain(
      'dwp_reconciliation_runs_total',
    );
  });

  it('replay idempotente incrementa dwp_wager_idempotent_replays_total', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      })
      .expect(201);
    createdWalletIds.push(wallet.body.id);

    const key = `metrics-replay:${randomUUID()}`;
    const payload = {
      providerId: 'provider-metrics',
      externalTransactionId: `tx-${randomUUID()}`,
      playerId,
      walletId: wallet.body.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: { amount: '5.00', currency: 'BRL' },
    };

    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);

    const before = await request(app.getHttpServer()).get('/metrics');
    const beforeReplay = metricValue(
      before.text,
      'dwp_wager_idempotent_replays_total',
      { kind: 'BET' },
    );

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.balance.amount).toBe('45.00');

    const after = await request(app.getHttpServer()).get('/metrics');
    const afterReplay = metricValue(
      after.text,
      'dwp_wager_idempotent_replays_total',
      { kind: 'BET' },
    );
    expect(afterReplay).toBe(beforeReplay + 1);
  });
});

function metricValue(
  body: string,
  name: string,
  labels: Record<string, string>,
): number {
  const lines = body.split('\n').filter((l) => l.startsWith(name + '{'));
  for (const line of lines) {
    const ok = Object.entries(labels).every(([k, v]) =>
      line.includes(`${k}="${v}"`),
    );
    if (!ok) continue;
    const m = line.match(/\s([0-9.eE+-]+)\s*$/);
    if (m) return Number(m[1]);
  }
  return 0;
}
