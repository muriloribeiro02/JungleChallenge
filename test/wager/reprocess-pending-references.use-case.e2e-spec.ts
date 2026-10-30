import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import { PlaceBetUseCase } from '../../src/application/use-cases/wager/place-bet.use-case';
import { RefundWagerUseCase } from '../../src/application/use-cases/wager/refund-wager.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/wager/reprocess-pending-references.use-case';
import { RollbackWagerUseCase } from '../../src/application/use-cases/wager/rollback-wager.use-case';
import { SettleWinUseCase } from '../../src/application/use-cases/wager/settle-win.use-case';
import {
  FAILURE_CODE_INVALID_REFERENCE_TYPE,
  FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
} from '../../src/domain/wager-transaction/wager-transaction.entity';
import dataSource from '../../src/infrastructure/database/data-source';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';

describe('ReprocessPendingReferences (e2e postgres)', () => {
  let connection: DataSource;
  let openWallet: OpenWalletUseCase;
  let placeBet: PlaceBetUseCase;
  let settleWin: SettleWinUseCase;
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
    settleWin = new SettleWinUseCase(uow);
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
      providerId: 'provider-reprocess-e2e',
      playerId,
      walletId,
      currency: 'BRL',
      roundId: 'round-reprocess',
      gameId: 'game-reprocess',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      ...overrides,
    };
  }

  it('1) REFUND pendente vira PROCESSED após PlaceBet (saldo, ledger, eventos)', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const futureBetExt = randomUUID();

    const pending = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '25.00',
      referenceExternalTransactionId: futureBetExt,
    });
    expect(pending.status).toBe('PENDING_REFERENCE');

    const bet = await placeBet.execute({
      ...base(playerId, wallet.id, { externalTransactionId: futureBetExt }),
      amount: '25.00',
    });
    expect(bet.status).toBe('PROCESSED');

    const out = await reprocess.execute({
      providerId: 'provider-reprocess-e2e',
      externalReference: futureBetExt,
    });

    expect(out.results).toHaveLength(1);
    expect(out.results[0].status).toBe('PROCESSED');
    expect(out.results[0].observedBalance).toBe('100.00');

    const bal = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].balance)).toContain('100');

    const ledger = await connection.query(
      `SELECT direction, amount::text FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.transactionId],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].direction).toBe('CREDIT');

    const txEvents = await connection.query(
      `SELECT event_type FROM outbox_message WHERE aggregate_id = $1 ORDER BY event_type`,
      [pending.transactionId],
    );
    expect(txEvents.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);

    const balanceEvents = await connection.query(
      `
        SELECT event_type FROM outbox_message
        WHERE event_type = 'WalletBalanceChanged'
          AND payload->'data'->>'transactionId' = $1
      `,
      [pending.transactionId],
    );
    expect(balanceEvents).toHaveLength(1);
  });

  it('2) ROLLBACK pendente de BET vira PROCESSED com CREDIT', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const futureBetExt = randomUUID();

    const pending = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '15.00',
      referenceExternalTransactionId: futureBetExt,
    });
    expect(pending.status).toBe('PENDING_REFERENCE');

    await placeBet.execute({
      ...base(playerId, wallet.id, { externalTransactionId: futureBetExt }),
      amount: '15.00',
    });

    const out = await reprocess.execute({
      providerId: 'provider-reprocess-e2e',
      externalReference: futureBetExt,
    });

    expect(out.results[0].status).toBe('PROCESSED');
    expect(out.results[0].observedBalance).toBe('100.00');

    const ledger = await connection.query(
      `SELECT direction FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.transactionId],
    );
    expect(ledger[0].direction).toBe('CREDIT');
  });

  it('3) pendência inválida (REFUND de WIN) → REJECTED sem ledger', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const winExt = randomUUID();

    const pending = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '40.00',
      referenceExternalTransactionId: winExt,
    });

    await settleWin.execute({
      ...base(playerId, wallet.id, { externalTransactionId: winExt }),
      amount: '40.00',
    });

    const out = await reprocess.execute({
      providerId: 'provider-reprocess-e2e',
      externalReference: winExt,
    });

    expect(out.results[0].status).toBe('REJECTED');
    expect(out.results[0].failureCode).toBe(
      FAILURE_CODE_INVALID_REFERENCE_TYPE,
    );

    const ledger = await connection.query(
      `SELECT 1 FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.transactionId],
    );
    expect(ledger).toHaveLength(0);

    const bal = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].balance)).toContain('140');
  });

  it('4) duas pendências da mesma referência: 1 PROCESSED + 1 REJECTED; um CREDIT', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const betExt = randomUUID();

    const p1 = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '20.00',
      referenceExternalTransactionId: betExt,
    });
    const p2 = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '20.00',
      referenceExternalTransactionId: betExt,
    });

    await placeBet.execute({
      ...base(playerId, wallet.id, { externalTransactionId: betExt }),
      amount: '20.00',
    });

    const out = await reprocess.execute({
      providerId: 'provider-reprocess-e2e',
      externalReference: betExt,
    });

    const statuses = out.results.map((r) => r.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = out.results.find((r) => r.status === 'REJECTED')!;
    expect(rejected.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);

    const bal = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].balance)).toContain('100');

    const credits = await connection.query(
      `
        SELECT COUNT(*)::int AS c
        FROM wallet_ledger_entry
        WHERE wallet_id = $1 AND direction = 'CREDIT'
          AND transaction_id = ANY($2::uuid[])
      `,
      [wallet.id, [p1.transactionId, p2.transactionId]],
    );
    expect(credits[0].c).toBe(1);
  });

  it('5) duas tentativas concorrentes da mesma pendência: um efeito financeiro', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const betExt = randomUUID();

    const pending = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '30.00',
      referenceExternalTransactionId: betExt,
    });

    await placeBet.execute({
      ...base(playerId, wallet.id, { externalTransactionId: betExt }),
      amount: '30.00',
    });

    const [a, b] = await Promise.all([
      reprocess.reprocessOne(pending.transactionId),
      reprocess.reprocessOne(pending.transactionId),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain('PROCESSED');
    expect(
      statuses.filter((s) => s === 'PROCESSED' || s === 'SKIPPED_TERMINAL'),
    ).toHaveLength(2);

    const bal = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].balance)).toContain('100');

    const ledger = await connection.query(
      `SELECT COUNT(*)::int AS c FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.transactionId],
    );
    expect(ledger[0].c).toBe(1);

    const processedEvents = await connection.query(
      `
        SELECT COUNT(*)::int AS c
        FROM outbox_message
        WHERE aggregate_id = $1 AND event_type = 'WagerTransactionProcessed'
      `,
      [pending.transactionId],
    );
    expect(processedEvents[0].c).toBe(1);

    const balanceEvents = await connection.query(
      `
        SELECT COUNT(*)::int AS c
        FROM outbox_message
        WHERE event_type = 'WalletBalanceChanged'
          AND payload->'data'->>'transactionId' = $1
      `,
      [pending.transactionId],
    );
    expect(balanceEvents[0].c).toBe(1);
  });

  it('6) reprocessamento repetido após PROCESSED não duplica efeitos', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const betExt = randomUUID();

    const pending = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '10.00',
      referenceExternalTransactionId: betExt,
    });
    await placeBet.execute({
      ...base(playerId, wallet.id, { externalTransactionId: betExt }),
      amount: '10.00',
    });

    await reprocess.execute({
      providerId: 'provider-reprocess-e2e',
      externalReference: betExt,
    });

    const again = await reprocess.reprocessOne(pending.transactionId);
    expect(again.status).toBe('SKIPPED_TERMINAL');

    const ledger = await connection.query(
      `SELECT COUNT(*)::int AS c FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.transactionId],
    );
    expect(ledger[0].c).toBe(1);

    const bal = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].balance)).toContain('100');
  });

  it('7) falha técnica no ledger faz rollback; pendência permanece PENDING', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const betExt = randomUUID();

    const pending = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '12.00',
      referenceExternalTransactionId: betExt,
    });
    await placeBet.execute({
      ...base(playerId, wallet.id, { externalTransactionId: betExt }),
      amount: '12.00',
    });

    const uow = new TypeOrmUnitOfWork(connection);
    const broken = new ReprocessPendingReferencesUseCase({
      run: async (work) =>
        uow.run(async (repos) => {
          const original = repos.ledgerEntries.save.bind(repos.ledgerEntries);
          repos.ledgerEntries.save = async () => {
            throw new Error('boom-reprocess-ledger');
          };
          try {
            return await work(repos);
          } finally {
            repos.ledgerEntries.save = original;
          }
        }),
    });

    await expect(broken.reprocessOne(pending.transactionId)).rejects.toThrow(
      'boom-reprocess-ledger',
    );

    const tx = await connection.query(
      `SELECT status, observed_balance FROM wager_transaction WHERE id = $1`,
      [pending.transactionId],
    );
    expect(tx[0].status).toBe('PENDING_REFERENCE');
    expect(tx[0].observed_balance).toBeNull();

    const bal = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].balance)).toContain('88');

    const ledger = await connection.query(
      `SELECT 1 FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.transactionId],
    );
    expect(ledger).toHaveLength(0);
  });

  it('11) pendência de outro provider não é processada', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const betExt = randomUUID();

    await refund.execute({
      ...base(playerId, wallet.id, { providerId: 'other-provider' }),
      amount: '8.00',
      referenceExternalTransactionId: betExt,
    });

    await placeBet.execute({
      ...base(playerId, wallet.id, { externalTransactionId: betExt }),
      amount: '8.00',
    });

    const out = await reprocess.execute({
      providerId: 'provider-reprocess-e2e',
      externalReference: betExt,
    });

    expect(out.results).toHaveLength(0);

    const pendingRows = await connection.query(
      `
        SELECT status, provider_id
        FROM wager_transaction
        WHERE kind = 'REFUND' AND external_reference = $1
      `,
      [betExt],
    );
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0].provider_id).toBe('other-provider');
    expect(pendingRows[0].status).toBe('PENDING_REFERENCE');
  });

  it('ROLLBACK pendente de WIN processado debita corretamente', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const winExt = randomUUID();

    const pending = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '35.00',
      referenceExternalTransactionId: winExt,
    });

    await settleWin.execute({
      ...base(playerId, wallet.id, { externalTransactionId: winExt }),
      amount: '35.00',
    });

    const out = await reprocess.execute({
      providerId: 'provider-reprocess-e2e',
      externalReference: winExt,
    });

    expect(out.results[0].status).toBe('PROCESSED');
    expect(out.results[0].observedBalance).toBe('100.00');

    const ledger = await connection.query(
      `SELECT direction FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.transactionId],
    );
    expect(ledger[0].direction).toBe('DEBIT');
  });
});
