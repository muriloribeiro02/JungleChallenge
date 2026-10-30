import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import { PlaceBetUseCase } from '../../src/application/use-cases/wager/place-bet.use-case';
import { RefundWagerUseCase } from '../../src/application/use-cases/wager/refund-wager.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/wager/reprocess-pending-references.use-case';
import { RollbackWagerUseCase } from '../../src/application/use-cases/wager/rollback-wager.use-case';
import { FAILURE_CODE_REFERENCE_ALREADY_REVERSED } from '../../src/domain/wager-transaction/wager-transaction.entity';
import dataSource from '../../src/infrastructure/database/data-source';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';

/**
 * Fase A / H1 — proteção cross-kind REFUND × ROLLBACK sobre a mesma BET.
 * Postgres real (sem mock de banco).
 */
describe('REFUND × ROLLBACK cross-kind (e2e postgres)', () => {
  let connection: DataSource;
  let openWallet: OpenWalletUseCase;
  let placeBet: PlaceBetUseCase;
  let refund: RefundWagerUseCase;
  let rollback: RollbackWagerUseCase;
  let reprocess: ReprocessPendingReferencesUseCase;
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
    rollback = new RollbackWagerUseCase(uow);
    reprocess = new ReprocessPendingReferencesUseCase(uow);
  });

  afterEach(async () => {
    if (walletIds.length === 0) {
      return;
    }
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

  afterAll(async () => {
    if (connection?.isInitialized) {
      await connection.destroy();
    }
  });

  async function seedWallet(balance: string) {
    const playerId = randomUUID();
    const wallet = await openWallet.execute({
      playerId,
      currency: 'BRL',
      initialBalance: balance,
    });
    walletIds.push(wallet.id);
    return { playerId, wallet };
  }

  function base(
    playerId: string,
    walletId: string,
    overrides: Record<string, string> = {},
  ) {
    return {
      providerId: 'provider-h1',
      playerId,
      walletId,
      currency: 'BRL',
      roundId: 'round-h1',
      gameId: 'game-h1',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      ...overrides,
    };
  }

  async function betExtFor(
    playerId: string,
    walletId: string,
    amount: string,
  ): Promise<{ betId: string; betExt: string }> {
    const bet = await placeBet.execute({
      ...base(playerId, walletId),
      amount,
    });
    const row = await connection.query(
      `SELECT id, external_transaction_id FROM wager_transaction WHERE id = $1`,
      [bet.transactionId],
    );
    return { betId: row[0].id, betExt: row[0].external_transaction_id };
  }

  async function assertBalanceEqualsLedger(walletId: string) {
    const bal = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [walletId],
    );
    const ledger = await connection.query(
      `
        SELECT
          COALESCE(
            SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END),
            0
          )::text AS delta
        FROM wallet_ledger_entry
        WHERE wallet_id = $1
      `,
      [walletId],
    );
    expect(Number.parseFloat(String(bal[0].balance))).toBeCloseTo(
      Number.parseFloat(String(ledger[0].delta)),
      2,
    );
  }

  async function creditCountForRef(betExt: string): Promise<number> {
    const rows = await connection.query(
      `
        SELECT COUNT(*)::int AS c
        FROM wallet_ledger_entry le
        JOIN wager_transaction tx ON tx.id = le.transaction_id
        WHERE tx.provider_id = 'provider-h1'
          AND tx.external_reference = $1
          AND tx.kind IN ('REFUND', 'ROLLBACK')
          AND tx.status = 'PROCESSED'
          AND le.direction = 'CREDIT'
      `,
      [betExt],
    );
    return rows[0].c as number;
  }

  it('1) REFUND seguido de REFUND: segundo REJECTED; um CREDIT', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const { betExt } = await betExtFor(playerId, wallet.id, '25.00');

    const first = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '25.00',
      referenceExternalTransactionId: betExt,
    });
    const second = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '25.00',
      referenceExternalTransactionId: betExt,
    });

    expect(first.status).toBe('PROCESSED');
    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
    expect(await creditCountForRef(betExt)).toBe(1);
    await assertBalanceEqualsLedger(wallet.id);
  });

  it('2) ROLLBACK seguido de ROLLBACK: segundo REJECTED; um CREDIT', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const { betExt } = await betExtFor(playerId, wallet.id, '25.00');

    const first = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '25.00',
      referenceExternalTransactionId: betExt,
    });
    const second = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '25.00',
      referenceExternalTransactionId: betExt,
    });

    expect(first.status).toBe('PROCESSED');
    expect(second.status).toBe('REJECTED');
    expect(second.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
    expect(await creditCountForRef(betExt)).toBe(1);
    await assertBalanceEqualsLedger(wallet.id);
  });

  it('3) REFUND seguido de ROLLBACK da mesma BET: ROLLBACK REJECTED', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const { betExt } = await betExtFor(playerId, wallet.id, '30.00');

    const rf = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '30.00',
      referenceExternalTransactionId: betExt,
    });
    const rb = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '30.00',
      referenceExternalTransactionId: betExt,
    });

    expect(rf.status).toBe('PROCESSED');
    expect(rb.status).toBe('REJECTED');
    expect(rb.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
    expect(await creditCountForRef(betExt)).toBe(1);

    const bal = await connection.query(
      `SELECT balance::text AS b FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].b)).toContain('100');
    await assertBalanceEqualsLedger(wallet.id);

    const events = await connection.query(
      `
        SELECT event_type FROM outbox_message
        WHERE aggregate_id = $1
        ORDER BY event_type
      `,
      [rb.transactionId],
    );
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionRejected',
    ]);
  });

  it('4) ROLLBACK seguido de REFUND da mesma BET: REFUND REJECTED', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const { betExt } = await betExtFor(playerId, wallet.id, '30.00');

    const rb = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '30.00',
      referenceExternalTransactionId: betExt,
    });
    const rf = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '30.00',
      referenceExternalTransactionId: betExt,
    });

    expect(rb.status).toBe('PROCESSED');
    expect(rf.status).toBe('REJECTED');
    expect(rf.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
    expect(await creditCountForRef(betExt)).toBe(1);
    await assertBalanceEqualsLedger(wallet.id);
  });

  it('5) REFUND e ROLLBACK simultâneos: exatamente um PROCESSED e um CREDIT', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const { betExt } = await betExtFor(playerId, wallet.id, '40.00');

    const [a, b] = await Promise.all([
      refund.execute({
        ...base(playerId, wallet.id),
        amount: '40.00',
        referenceExternalTransactionId: betExt,
      }),
      rollback.execute({
        ...base(playerId, wallet.id),
        amount: '40.00',
        referenceExternalTransactionId: betExt,
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = a.status === 'REJECTED' ? a : b;
    expect(rejected.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
    expect(await creditCountForRef(betExt)).toBe(1);

    const processedKinds = await connection.query(
      `
        SELECT kind FROM wager_transaction
        WHERE provider_id = 'provider-h1'
          AND external_reference = $1
          AND status = 'PROCESSED'
          AND kind IN ('REFUND', 'ROLLBACK')
      `,
      [betExt],
    );
    expect(processedKinds).toHaveLength(1);

    const bal = await connection.query(
      `SELECT balance::text AS b FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].b)).toContain('100');
    await assertBalanceEqualsLedger(wallet.id);
  });

  it('6) reprocessamento concorrente de pendências REFUND+ROLLBACK', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const betExt = randomUUID();

    const pendingRf = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '20.00',
      referenceExternalTransactionId: betExt,
    });
    const pendingRb = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '20.00',
      referenceExternalTransactionId: betExt,
    });
    expect(pendingRf.status).toBe('PENDING_REFERENCE');
    expect(pendingRb.status).toBe('PENDING_REFERENCE');

    await placeBet.execute({
      ...base(playerId, wallet.id, { externalTransactionId: betExt }),
      amount: '20.00',
    });

    const [a, b] = await Promise.all([
      reprocess.reprocessOne(pendingRf.transactionId),
      reprocess.reprocessOne(pendingRb.transactionId),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(
      [a, b].find((r) => r.status === 'REJECTED')?.failureCode,
    ).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);
    expect(await creditCountForRef(betExt)).toBe(1);
    await assertBalanceEqualsLedger(wallet.id);
  });

  it('7) falha técnica no ledger faz rollback; depois REFUND×ROLLBACK ainda exclusivos', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const { betExt } = await betExtFor(playerId, wallet.id, '15.00');

    const uow = new TypeOrmUnitOfWork(connection);
    const broken = new RefundWagerUseCase({
      run: async (work) =>
        uow.run(async (repos) => {
          const original = repos.ledgerEntries.save.bind(repos.ledgerEntries);
          repos.ledgerEntries.save = async () => {
            throw new Error('boom-h1-ledger');
          };
          try {
            return await work(repos);
          } finally {
            repos.ledgerEntries.save = original;
          }
        }),
    });

    await expect(
      broken.execute({
        ...base(playerId, wallet.id),
        amount: '15.00',
        referenceExternalTransactionId: betExt,
      }),
    ).rejects.toThrow('boom-h1-ledger');

    const rf = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '15.00',
      referenceExternalTransactionId: betExt,
    });
    const rb = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '15.00',
      referenceExternalTransactionId: betExt,
    });

    expect(rf.status).toBe('PROCESSED');
    expect(rb.status).toBe('REJECTED');
    expect(await creditCountForRef(betExt)).toBe(1);
    await assertBalanceEqualsLedger(wallet.id);
  });

  it('8-10) UNIQUE PG bloqueia INSERT cross-kind; saldo e eventos consistentes', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const { betId, betExt } = await betExtFor(playerId, wallet.id, '12.00');

    const rf = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '12.00',
      referenceExternalTransactionId: betExt,
    });
    expect(rf.status).toBe('PROCESSED');

    await expect(
      connection.query(
        `
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, external_reference, resolved_internal_reference,
            observed_balance, observed_wallet_version, created_at, updated_at
          ) VALUES (
            $1, $2, $3, 'ROLLBACK', 'PROCESSED', 12.00, 'BRL',
            'provider-h1', $4, $5, 'hash',
            'round-h1', 'game-h1', $6, $7,
            100.00, 3, NOW(), NOW()
          )
        `,
        [
          randomUUID(),
          wallet.id,
          playerId,
          randomUUID(),
          randomUUID(),
          betExt,
          betId,
        ],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_wager_transaction_processed_reversal_ref',
    });

    expect(await creditCountForRef(betExt)).toBe(1);
    await assertBalanceEqualsLedger(wallet.id);

    const processedEvents = await connection.query(
      `
        SELECT COUNT(*)::int AS c
        FROM outbox_message
        WHERE aggregate_id = $1 AND event_type = 'WagerTransactionProcessed'
      `,
      [rf.transactionId],
    );
    expect(processedEvents[0].c).toBe(1);

    const balanceEvents = await connection.query(
      `
        SELECT COUNT(*)::int AS c
        FROM outbox_message
        WHERE event_type = 'WalletBalanceChanged'
          AND payload->'data'->>'transactionId' = $1
      `,
      [rf.transactionId],
    );
    expect(balanceEvents[0].c).toBe(1);
  });

  it('ROLLBACK de REFUND (não da BET) continua permitido', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const { betExt } = await betExtFor(playerId, wallet.id, '18.00');

    const rf = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '18.00',
      referenceExternalTransactionId: betExt,
    });
    const refundExt = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [rf.transactionId],
      )
    )[0].external_transaction_id;

    const rbRefund = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '18.00',
      referenceExternalTransactionId: refundExt,
    });

    expect(rbRefund.status).toBe('PROCESSED');
    const dir = await connection.query(
      `SELECT direction FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [rbRefund.transactionId],
    );
    expect(dir[0].direction).toBe('DEBIT');

    const bal = await connection.query(
      `SELECT balance::text AS b FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].b)).toContain('82');
    await assertBalanceEqualsLedger(wallet.id);
  });
});
