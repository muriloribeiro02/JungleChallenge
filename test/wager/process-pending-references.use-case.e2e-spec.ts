import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ProcessPendingReferencesUseCase } from '../../src/application/use-cases/wager/process-pending-references.use-case';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import { PlaceBetUseCase } from '../../src/application/use-cases/wager/place-bet.use-case';
import { RefundWagerUseCase } from '../../src/application/use-cases/wager/refund-wager.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/wager/reprocess-pending-references.use-case';
import { FAILURE_CODE_REFERENCE_NOT_FOUND } from '../../src/domain/wager-transaction/wager-transaction.entity';
import dataSource from '../../src/infrastructure/database/data-source';
import { ConsoleMessagingLogger } from '../../src/infrastructure/logging/console-messaging-logger';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';

/**
 * C2 — TTL / claim SKIP LOCKED / REFERENCE_NOT_FOUND + Outbox atômico.
 */
describe('ProcessPendingReferences (e2e postgres)', () => {
  let connection: DataSource;
  let openWallet: OpenWalletUseCase;
  let placeBet: PlaceBetUseCase;
  let refund: RefundWagerUseCase;
  let reprocess: ReprocessPendingReferencesUseCase;
  let worker: ProcessPendingReferencesUseCase;
  const walletIds: string[] = [];

  beforeAll(async () => {
    connection = dataSource;
    if (!connection.isInitialized) {
      await connection.initialize();
    }
    await connection.runMigrations();
    const uow = new TypeOrmUnitOfWork(connection);
    openWallet = new OpenWalletUseCase(uow);
    placeBet = new PlaceBetUseCase(uow);
    refund = new RefundWagerUseCase(uow);
    reprocess = new ReprocessPendingReferencesUseCase(uow);
    worker = new ProcessPendingReferencesUseCase(
      uow,
      reprocess,
      new ConsoleMessagingLogger(),
      { batchSize: 20, leaseSeconds: 15 },
    );
  });

  afterAll(async () => {
    if (connection?.isInitialized) {
      await connection.destroy();
    }
  });

  afterEach(async () => {
    if (walletIds.length === 0) return;
    const qr = connection.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SET LOCAL session_replication_role = 'replica'`);
      await qr.query(
        `
          DELETE FROM outbox_message
          WHERE aggregate_id = ANY($1::uuid[])
             OR aggregate_id IN (
               SELECT id FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])
             )
        `,
        [walletIds],
      );
      await qr.query(
        `DELETE FROM wallet_ledger_entry WHERE wallet_id = ANY($1::uuid[])`,
        [walletIds],
      );
      await qr.query(
        `DELETE FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])`,
        [walletIds],
      );
      await qr.query(`DELETE FROM wallet WHERE id = ANY($1::uuid[])`, [
        walletIds,
      ]);
      await qr.commitTransaction();
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
      walletIds.length = 0;
    }
  });

  async function open(): Promise<{
    walletId: string;
    playerId: string;
  }> {
    const playerId = randomUUID();
    const wallet = await openWallet.execute({
      playerId,
      currency: 'BRL',
      initialBalance: '100.00',
    });
    walletIds.push(wallet.id);
    return { walletId: wallet.id, playerId };
  }

  it('TTL expirado → REJECTED REFERENCE_NOT_FOUND + Outbox na mesma UoW; sem ledger', async () => {
    const { walletId, playerId } = await open();
    const pending = await refund.execute({
      providerId: 'provider-ttl',
      playerId,
      walletId,
      amount: '10.00',
      currency: 'BRL',
      roundId: 'round-ttl',
      gameId: 'game-ttl',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId: randomUUID(),
    });
    expect(pending.status).toBe('PENDING_REFERENCE');

    await connection.query(
      `
        UPDATE wager_transaction
        SET pending_reference_at = NOW() - INTERVAL '25 hours',
            next_attempt_at = NOW() + INTERVAL '10 minutes'
        WHERE id = $1
      `,
      [pending.transactionId],
    );

    const batch = await worker.processBatch();
    expect(batch.claimed).toBeGreaterThanOrEqual(1);
    expect(batch.expired).toBeGreaterThanOrEqual(1);

    const rows = await connection.query(
      `SELECT status, failure_code FROM wager_transaction WHERE id = $1`,
      [pending.transactionId],
    );
    expect(rows[0].status).toBe('REJECTED');
    expect(rows[0].failure_code).toBe(FAILURE_CODE_REFERENCE_NOT_FOUND);

    const outbox = await connection.query(
      `
        SELECT event_type, payload
        FROM outbox_message
        WHERE aggregate_id = $1 AND event_type = 'WagerTransactionRejected'
      `,
      [pending.transactionId],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload.data.failureCode).toBe(
      FAILURE_CODE_REFERENCE_NOT_FOUND,
    );

    const ledger = await connection.query(
      `SELECT 1 FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.transactionId],
    );
    expect(ledger).toHaveLength(0);
  });

  it('três workers concorrentes: uma única transição terminal e um único Rejected', async () => {
    const { walletId, playerId } = await open();
    const pending = await refund.execute({
      providerId: 'provider-race',
      playerId,
      walletId,
      amount: '5.00',
      currency: 'BRL',
      roundId: 'round-race',
      gameId: 'game-race',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId: randomUUID(),
    });

    await connection.query(
      `
        UPDATE wager_transaction
        SET pending_reference_at = NOW() - INTERVAL '26 hours',
            next_attempt_at = NOW() + INTERVAL '1 hour',
            locked_until = NULL
        WHERE id = $1
      `,
      [pending.transactionId],
    );

    const results = await Promise.all([
      worker.processBatch(),
      worker.processBatch(),
      worker.processBatch(),
    ]);

    const totalExpired = results.reduce((s, r) => s + r.expired, 0);
    expect(totalExpired).toBe(1);

    const status = await connection.query(
      `SELECT status, failure_code FROM wager_transaction WHERE id = $1`,
      [pending.transactionId],
    );
    expect(status[0].status).toBe('REJECTED');
    expect(status[0].failure_code).toBe(FAILURE_CODE_REFERENCE_NOT_FOUND);

    const outbox = await connection.query(
      `
        SELECT id FROM outbox_message
        WHERE aggregate_id = $1 AND event_type = 'WagerTransactionRejected'
      `,
      [pending.transactionId],
    );
    expect(outbox).toHaveLength(1);
  });

  it('referência aparece antes do TTL → PROCESSED (comportamento preservado)', async () => {
    const { walletId, playerId } = await open();
    const betExt = randomUUID();
    await placeBet.execute({
      providerId: 'provider-ok',
      playerId,
      walletId,
      amount: '15.00',
      currency: 'BRL',
      roundId: 'round-ok',
      gameId: 'game-ok',
      externalTransactionId: betExt,
      idempotencyKey: randomUUID(),
    });

    const pending = await refund.execute({
      providerId: 'provider-ok',
      playerId,
      walletId,
      amount: '15.00',
      currency: 'BRL',
      roundId: 'round-ok',
      gameId: 'game-ok',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId: betExt,
    });

    // Já deveria ter sido processável; se ainda pending (ordem), reprocessa.
    if (pending.status === 'PENDING_REFERENCE') {
      const result = await reprocess.reprocessOne(pending.transactionId);
      expect(result.status).toBe('PROCESSED');
    } else {
      expect(pending.status).toBe('PROCESSED');
    }

    const rows = await connection.query(
      `SELECT status, failure_code FROM wager_transaction WHERE id = $1`,
      [pending.transactionId],
    );
    expect(rows[0].status).toBe('PROCESSED');
    expect(rows[0].failure_code).toBeNull();
  });
});
