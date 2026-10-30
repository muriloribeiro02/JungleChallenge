import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import dataSource from '../../src/infrastructure/database/data-source';

describe('HTTP API (e2e)', () => {
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
        `DELETE FROM inbox_message WHERE id IN (
           SELECT id::text FROM outbox_message WHERE aggregate_id = ANY($1::uuid[])
             OR aggregate_id IN (SELECT id FROM wager_transaction WHERE wallet_id = ANY($1::uuid[]))
         )`,
        [createdWalletIds],
      );
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

  it('GET /health/live', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });

  it('wallet inexistente → 404 (GET, ledger, reconciliation, REFUND/ROLLBACK)', async () => {
    const missingWalletId = randomUUID();
    const playerId = randomUUID();

    const getWallet = await request(app.getHttpServer())
      .get(`/wallets/${missingWalletId}`)
      .expect(404);
    expect(getWallet.body).toMatchObject({
      statusCode: 404,
      error: 'WalletNotFoundError',
    });

    const ledger = await request(app.getHttpServer())
      .get(`/wallets/${missingWalletId}/ledger?limit=10`)
      .expect(404);
    expect(ledger.body).toMatchObject({
      statusCode: 404,
      error: 'WalletNotFoundError',
    });

    const recon = await request(app.getHttpServer())
      .post(`/wallets/${missingWalletId}/reconciliation`)
      .expect(404);
    expect(recon.body).toMatchObject({
      statusCode: 404,
      error: 'WalletNotFoundError',
    });

    const refund = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:${randomUUID()}`)
      .send({
        providerId: 'provider-http',
        externalTransactionId: randomUUID(),
        playerId,
        walletId: missingWalletId,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'REFUND',
        money: { amount: '1.00', currency: 'BRL' },
        referenceExternalTransactionId: randomUUID(),
      })
      .expect(404);
    expect(refund.body.error).toBe('WalletNotFoundForRefundError');

    const rollback = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:${randomUUID()}`)
      .send({
        providerId: 'provider-http',
        externalTransactionId: randomUUID(),
        playerId,
        walletId: missingWalletId,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'ROLLBACK',
        money: { amount: '1.00', currency: 'BRL' },
        referenceExternalTransactionId: randomUUID(),
      })
      .expect(404);
    expect(rollback.body.error).toBe('WalletNotFoundForRollbackError');
  });

  it('transação inexistente → 404 (por id e por provider/external)', async () => {
    const missingTxId = randomUUID();
    const byId = await request(app.getHttpServer())
      .get(`/wagering/transactions/${missingTxId}`)
      .expect(404);
    expect(byId.body).toMatchObject({
      statusCode: 404,
      error: 'WagerTransactionNotFoundError',
    });

    const byExt = await request(app.getHttpServer())
      .get(
        `/providers/provider-http/wagering/transactions/${randomUUID()}`,
      )
      .expect(404);
    expect(byExt.body).toMatchObject({
      statusCode: 404,
      error: 'WagerTransactionNotFoundError',
    });
  });

  it('externalTransactionId duplicado em WIN → 409', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    createdWalletIds.push(wallet.body.id);

    const sharedExt = randomUUID();
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:${sharedExt}`)
      .send({
        providerId: 'provider-http',
        externalTransactionId: sharedExt,
        playerId,
        walletId: wallet.body.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      })
      .expect(200);

    // Submit repropaga ExternalTransactionIdConflictError (409); wrappers
    // ForWin/ForLoss/… são cobertos no unitário do filtro.
    const conflict = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:win-${sharedExt}`)
      .send({
        providerId: 'provider-http',
        externalTransactionId: sharedExt,
        playerId,
        walletId: wallet.body.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'WIN',
        money: { amount: '5.00', currency: 'BRL' },
      })
      .expect(409);
    expect(conflict.body.error).toBe('ExternalTransactionIdConflictError');
  });

  it('POST /wallets cria wallet e GET consulta saldo string', async () => {
    const playerId = randomUUID();
    const create = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);

    expect(create.body.balance.amount).toBe('100.00');
    expect(typeof create.body.balance.amount).toBe('string');
    createdWalletIds.push(create.body.id);

    const get = await request(app.getHttpServer())
      .get(`/wallets/${create.body.id}`)
      .expect(200);
    expect(get.body.balance.amount).toBe('100.00');
    expect(get.body.playerId).toBe(playerId);

    const ledger = await dataSource.query(
      `SELECT COUNT(*)::int AS c FROM wallet_ledger_entry WHERE wallet_id = $1`,
      [create.body.id],
    );
    expect(ledger[0].c).toBe(1);
  });

  it('POST /wallets duplicada → 409', async () => {
    const playerId = randomUUID();
    const first = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      })
      .expect(201);
    createdWalletIds.push(first.body.id);

    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      })
      .expect(409);
  });

  it('POST /wagering/transactions BET + idempotência + saldo insuficiente', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      })
      .expect(201);
    createdWalletIds.push(wallet.body.id);

    const ext = randomUUID();
    const body = {
      providerId: 'provider-http',
      externalTransactionId: ext,
      playerId,
      walletId: wallet.body.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    };

    const first = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:${ext}`)
      .send(body)
      .expect(200);

    expect(first.body.status).toBe('PROCESSED');
    expect(first.body.idempotentReplay).toBe(false);
    expect(first.body.balance.amount).toBe('30.00');

    const replay = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:${ext}`)
      .send(body)
      .expect(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);

    const conflict = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:${ext}`)
      .send({ ...body, money: { amount: '21.00', currency: 'BRL' } })
      .expect(409);

    expect(conflict.body.error).toBeTruthy();

    const poor = randomUUID();
    const rejected = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:${poor}`)
      .send({
        ...body,
        externalTransactionId: poor,
        money: { amount: '40.00', currency: 'BRL' },
      })
      .expect(200);
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    const bal = await dataSource.query(
      `SELECT balance::text AS b FROM wallet WHERE id = $1`,
      [wallet.body.id],
    );
    expect(String(bal[0].b)).toContain('30');
  });

  it('sem Idempotency-Key → 400; amount number → 400; magnitude excessiva → 400', async () => {
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send({
        providerId: 'p',
        externalTransactionId: 'e',
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: 100, currency: 'BRL' },
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: {
          amount: '100000000000000000.00',
          currency: 'BRL',
        },
      })
      .expect(400);
  });

  it('REFUND com referência ausente → 202 PENDING_REFERENCE sem efeito financeiro', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      })
      .expect(201);
    createdWalletIds.push(wallet.body.id);

    const missingRef = randomUUID();
    const ext = randomUUID();
    const pending = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:${ext}`)
      .send({
        providerId: 'provider-http',
        externalTransactionId: ext,
        playerId,
        walletId: wallet.body.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'REFUND',
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: missingRef,
      })
      .expect(202);

    expect(pending.body.status).toBe('PENDING_REFERENCE');
    expect(pending.body.transactionId).toBeTruthy();
    expect(pending.body.balance).toBeNull();
    // PENDING_REFERENCE não carrega failureCode (REFERENCE_NOT_FOUND só após TTL).
    expect(pending.body.failureCode).toBeUndefined();
    expect(pending.body.idempotentReplay).toBe(false);

    const bal = await dataSource.query(
      `SELECT balance::text AS b, version FROM wallet WHERE id = $1`,
      [wallet.body.id],
    );
    expect(String(bal[0].b)).toContain('100');
    expect(bal[0].version).toBe(1);

    const ledger = await dataSource.query(
      `SELECT 1 FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.body.transactionId],
    );
    expect(ledger).toHaveLength(0);

    const tx = await dataSource.query(
      `
        SELECT status, external_reference, failure_code, observed_balance
        FROM wager_transaction WHERE id = $1
      `,
      [pending.body.transactionId],
    );
    expect(tx[0].status).toBe('PENDING_REFERENCE');
    expect(tx[0].external_reference).toBe(missingRef);
    expect(tx[0].failure_code).toBeNull();
    expect(tx[0].observed_balance).toBeNull();

    const outbox = await dataSource.query(
      `SELECT event_type FROM outbox_message WHERE aggregate_id = $1`,
      [pending.body.transactionId],
    );
    expect(outbox.map((r: { event_type: string }) => r.event_type)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  it('reconciliação e consultas de ledger/transação', async () => {
    const playerId = randomUUID();
    const wallet = await request(app.getHttpServer())
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '80.00', currency: 'BRL' },
      })
      .expect(201);
    createdWalletIds.push(wallet.body.id);

    const ext = randomUUID();
    const bet = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', `provider-http:${ext}`)
      .send({
        providerId: 'provider-http',
        externalTransactionId: ext,
        playerId,
        walletId: wallet.body.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      })
      .expect(200);

    const recon = await request(app.getHttpServer())
      .post(`/wallets/${wallet.body.id}/reconciliation`)
      .expect(200);
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.checkedEntries).toBeGreaterThanOrEqual(2);

    const ledger = await request(app.getHttpServer())
      .get(`/wallets/${wallet.body.id}/ledger?limit=10`)
      .expect(200);
    expect(Array.isArray(ledger.body.items)).toBe(true);
    expect(ledger.body.items[0].money.amount).toEqual(
      expect.stringMatching(/^\d+\.\d{2}$/),
    );

    await request(app.getHttpServer())
      .get(`/wagering/transactions/${bet.body.transactionId}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/providers/provider-http/wagering/transactions/${ext}`)
      .expect(200);
  });
});
