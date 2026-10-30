import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import { PlaceBetUseCase } from '../../src/application/use-cases/wager/place-bet.use-case';
import { RefundWagerUseCase } from '../../src/application/use-cases/wager/refund-wager.use-case';
import { RollbackWagerUseCase } from '../../src/application/use-cases/wager/rollback-wager.use-case';
import { SettleWinUseCase } from '../../src/application/use-cases/wager/settle-win.use-case';
import {
  FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
  FAILURE_CODE_REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
} from '../../src/domain/wager-transaction/wager-transaction.entity';
import dataSource from '../../src/infrastructure/database/data-source';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';

describe('Refund / Rollback (e2e postgres)', () => {
  let connection: DataSource;
  let openWallet: OpenWalletUseCase;
  let placeBet: PlaceBetUseCase;
  let settleWin: SettleWinUseCase;
  let refund: RefundWagerUseCase;
  let rollback: RollbackWagerUseCase;
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
      providerId: 'provider-reversal',
      playerId,
      walletId,
      currency: 'BRL',
      roundId: 'round-rev',
      gameId: 'game-rev',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      ...overrides,
    };
  }

  it('REFUND altera saldo e gera CREDIT', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const bet = await placeBet.execute({
      ...base(playerId, wallet.id),
      amount: '25.00',
    });

    const result = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '25.00',
      referenceExternalTransactionId: (
        await connection.query(
          `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
          [bet.transactionId],
        )
      )[0].external_transaction_id,
    });

    expect(result.status).toBe('PROCESSED');
    expect(result.observedBalance).toBe('100.00');

    const ledger = await connection.query(
      `SELECT direction FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [result.transactionId],
    );
    expect(ledger[0].direction).toBe('CREDIT');
  });

  it('ROLLBACK inverte BET (CREDIT), WIN (DEBIT) e REFUND (DEBIT)', async () => {
    const { playerId, wallet } = await seedWallet('100.00');

    const bet = await placeBet.execute({
      ...base(playerId, wallet.id),
      amount: '20.00',
    });
    const betExt = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [bet.transactionId],
      )
    )[0].external_transaction_id;

    const rbBet = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '20.00',
      referenceExternalTransactionId: betExt,
    });
    expect(rbBet.status).toBe('PROCESSED');
    expect(rbBet.observedBalance).toBe('100.00');
    expect(
      (
        await connection.query(
          `SELECT direction FROM wallet_ledger_entry WHERE transaction_id = $1`,
          [rbBet.transactionId],
        )
      )[0].direction,
    ).toBe('CREDIT');

    const win = await settleWin.execute({
      ...base(playerId, wallet.id),
      amount: '40.00',
    });
    const winExt = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [win.transactionId],
      )
    )[0].external_transaction_id;

    const rbWin = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '40.00',
      referenceExternalTransactionId: winExt,
    });
    expect(rbWin.status).toBe('PROCESSED');
    expect(rbWin.observedBalance).toBe('100.00');
    expect(
      (
        await connection.query(
          `SELECT direction FROM wallet_ledger_entry WHERE transaction_id = $1`,
          [rbWin.transactionId],
        )
      )[0].direction,
    ).toBe('DEBIT');

    const bet2 = await placeBet.execute({
      ...base(playerId, wallet.id),
      amount: '15.00',
    });
    const bet2Ext = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [bet2.transactionId],
      )
    )[0].external_transaction_id;
    const refunded = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '15.00',
      referenceExternalTransactionId: bet2Ext,
    });
    const refundExt = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [refunded.transactionId],
      )
    )[0].external_transaction_id;

    const rbRefund = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '15.00',
      referenceExternalTransactionId: refundExt,
    });
    expect(rbRefund.status).toBe('PROCESSED');
    expect(
      (
        await connection.query(
          `SELECT direction FROM wallet_ledger_entry WHERE transaction_id = $1`,
          [rbRefund.transactionId],
        )
      )[0].direction,
    ).toBe('DEBIT');
  });

  it('referência ausente → PENDING_REFERENCE sem ledger nem mudança de saldo', async () => {
    const { playerId, wallet } = await seedWallet('100.00');

    const result = await refund.execute({
      ...base(playerId, wallet.id),
      amount: '10.00',
      referenceExternalTransactionId: randomUUID(),
    });

    expect(result.status).toBe('PENDING_REFERENCE');

    const bal = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].balance)).toContain('100');
    expect(bal[0].version).toBe(1);

    const ledger = await connection.query(
      `SELECT 1 FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [result.transactionId],
    );
    expect(ledger).toHaveLength(0);

    const tx = await connection.query(
      `
        SELECT status, observed_balance, observed_wallet_version, external_reference
        FROM wager_transaction WHERE id = $1
      `,
      [result.transactionId],
    );
    expect(tx[0].status).toBe('PENDING_REFERENCE');
    expect(tx[0].observed_balance).toBeNull();
    expect(tx[0].observed_wallet_version).toBeNull();
    expect(tx[0].external_reference).toBeTruthy();

    const outbox = await connection.query(
      `SELECT event_type FROM outbox_message WHERE aggregate_id = $1`,
      [result.transactionId],
    );
    expect(outbox.map((r: { event_type: string }) => r.event_type)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  it('reversão duplicada rejeitada inclusive sob concorrência', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const bet = await placeBet.execute({
      ...base(playerId, wallet.id),
      amount: '30.00',
    });
    const betExt = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [bet.transactionId],
      )
    )[0].external_transaction_id;

    const [a, b] = await Promise.all([
      refund.execute({
        ...base(playerId, wallet.id),
        amount: '30.00',
        referenceExternalTransactionId: betExt,
      }),
      refund.execute({
        ...base(playerId, wallet.id),
        amount: '30.00',
        referenceExternalTransactionId: betExt,
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = a.status === 'REJECTED' ? a : b;
    expect(rejected.failureCode).toBe(FAILURE_CODE_REFERENCE_ALREADY_REVERSED);

    const processedCount = await connection.query(
      `
        SELECT COUNT(*)::int AS c
        FROM wager_transaction
        WHERE kind = 'REFUND'
          AND status = 'PROCESSED'
          AND provider_id = $1
          AND external_reference = $2
      `,
      ['provider-reversal', betExt],
    );
    expect(processedCount[0].c).toBe(1);
  });

  it('replay preserva snapshot do REFUND', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const bet = await placeBet.execute({
      ...base(playerId, wallet.id),
      amount: '12.00',
    });
    const betExt = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [bet.transactionId],
      )
    )[0].external_transaction_id;
    const key = randomUUID();
    const payload = {
      ...base(playerId, wallet.id, { idempotencyKey: key }),
      amount: '12.00',
      referenceExternalTransactionId: betExt,
    };

    const first = await refund.execute(payload);
    const second = await refund.execute(payload);

    expect(second.transactionId).toBe(first.transactionId);
    expect(second.observedBalance).toBe(first.observedBalance);
    expect(second.walletVersion).toBe(first.walletVersion);
  });

  it('ROLLBACK com saldo insuficiente persiste REJECTED sem ledger', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const win = await settleWin.execute({
      ...base(playerId, wallet.id),
      amount: '50.00',
    });
    // gasta quase tudo com BET
    await placeBet.execute({
      ...base(playerId, wallet.id),
      amount: '140.00',
    });
    const winExt = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [win.transactionId],
      )
    )[0].external_transaction_id;

    const result = await rollback.execute({
      ...base(playerId, wallet.id),
      amount: '50.00',
      referenceExternalTransactionId: winExt,
    });

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(
      FAILURE_CODE_REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
    );
    const ledger = await connection.query(
      `SELECT 1 FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [result.transactionId],
    );
    expect(ledger).toHaveLength(0);
  });

  it('falha de persistência do ledger faz rollback transacional', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const bet = await placeBet.execute({
      ...base(playerId, wallet.id),
      amount: '10.00',
    });
    const betExt = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [bet.transactionId],
      )
    )[0].external_transaction_id;

    const uow = new TypeOrmUnitOfWork(connection);
    const broken = new RefundWagerUseCase({
      run: async (work) =>
        uow.run(async (repos) => {
          const original = repos.ledgerEntries.save.bind(repos.ledgerEntries);
          repos.ledgerEntries.save = async () => {
            throw new Error('boom-ledger');
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
        amount: '10.00',
        referenceExternalTransactionId: betExt,
      }),
    ).rejects.toThrow('boom-ledger');

    const bal = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].balance)).toContain('90');

    const refunds = await connection.query(
      `
        SELECT 1 FROM wager_transaction
        WHERE wallet_id = $1 AND kind = 'REFUND'
      `,
      [wallet.id],
    );
    expect(refunds).toHaveLength(0);
  });

  it('constraint UNIQUE impede dois REFUND PROCESSED da mesma referência', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const bet = await placeBet.execute({
      ...base(playerId, wallet.id),
      amount: '8.00',
    });
    const betExt = (
      await connection.query(
        `SELECT external_transaction_id FROM wager_transaction WHERE id = $1`,
        [bet.transactionId],
      )
    )[0].external_transaction_id;

    await refund.execute({
      ...base(playerId, wallet.id),
      amount: '8.00',
      referenceExternalTransactionId: betExt,
    });

    await expect(
      connection.query(
        `
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, external_reference, resolved_internal_reference,
            observed_balance, observed_wallet_version, created_at, updated_at
          ) VALUES (
            $1, $2, $3, 'REFUND', 'PROCESSED', 8.00, 'BRL',
            'provider-reversal', $4, $5, 'hash',
            'round-rev', 'game-rev', $6, $7,
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
          bet.transactionId,
        ],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_wager_transaction_processed_reversal_ref',
    });
  });
});
