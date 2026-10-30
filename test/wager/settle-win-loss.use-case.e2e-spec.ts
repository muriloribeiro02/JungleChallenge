import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import { PlaceBetUseCase } from '../../src/application/use-cases/wager/place-bet.use-case';
import { SettleLossUseCase } from '../../src/application/use-cases/wager/settle-loss.use-case';
import { SettleWinUseCase } from '../../src/application/use-cases/wager/settle-win.use-case';
import { ExternalTransactionConflictForWinError } from '../../src/application/use-cases/wager/settle-win.errors';
import { IdempotencyPayloadConflictForLossError } from '../../src/application/use-cases/wager/settle-loss.errors';
import dataSource from '../../src/infrastructure/database/data-source';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';

describe('SettleWin / SettleLoss (e2e postgres)', () => {
  let connection: DataSource;
  let openWallet: OpenWalletUseCase;
  let placeBet: PlaceBetUseCase;
  let settleWin: SettleWinUseCase;
  let settleLoss: SettleLossUseCase;
  const walletIds: string[] = [];

  beforeAll(async () => {
    connection = dataSource;
    if (!connection.isInitialized) {
      await connection.initialize();
    }
    const uow = new TypeOrmUnitOfWork(connection);
    openWallet = new OpenWalletUseCase(uow);
    placeBet = new PlaceBetUseCase(uow);
    settleWin = new SettleWinUseCase(uow);
    settleLoss = new SettleLossUseCase(uow);
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

  function baseInput(
    playerId: string,
    walletId: string,
    overrides: Record<string, string> = {},
  ) {
    return {
      providerId: 'provider-settle',
      playerId,
      walletId,
      currency: 'BRL',
      roundId: 'round-settle',
      gameId: 'game-settle',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      ...overrides,
    };
  }

  it('WIN aumenta saldo/version, cria CREDIT e dois eventos', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const result = await settleWin.execute({
      ...baseInput(playerId, wallet.id),
      amount: '40.00',
    });

    expect(result.status).toBe('PROCESSED');
    expect(result.observedBalance).toBe('140.00');
    expect(result.walletVersion).toBe(2);

    const row = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('140');
    expect(row[0].version).toBe(2);

    const tx = await connection.query(
      `
        SELECT kind, status, observed_balance::text, observed_wallet_version
        FROM wager_transaction WHERE id = $1
      `,
      [result.transactionId],
    );
    expect(tx[0].kind).toBe('WIN');
    expect(tx[0].status).toBe('PROCESSED');
    expect(tx[0].observed_wallet_version).toBe(2);

    const ledger = await connection.query(
      `SELECT direction FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [result.transactionId],
    );
    expect(ledger[0].direction).toBe('CREDIT');

    const outbox = await connection.query(
      `
        SELECT event_type FROM outbox_message
        WHERE aggregate_id = $1::uuid
           OR (
             event_type = 'WalletBalanceChanged'
             AND payload->'data'->>'transactionId' = $1::text
           )
        ORDER BY event_type
      `,
      [result.transactionId],
    );
    expect(outbox.map((o: { event_type: string }) => o.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('LOSS mantém saldo/version, sem ledger, só Processed', async () => {
    const { playerId, wallet } = await seedWallet('75.00');
    const result = await settleLoss.execute({
      ...baseInput(playerId, wallet.id),
      amount: '0.00',
    });

    expect(result.status).toBe('PROCESSED');
    expect(result.amount).toBe('0.00');
    expect(result.observedBalance).toBe('75.00');
    expect(result.walletVersion).toBe(1);

    const row = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('75');
    expect(row[0].version).toBe(1);

    const ledger = await connection.query(
      `SELECT id FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [result.transactionId],
    );
    expect(ledger).toHaveLength(0);

    const outbox = await connection.query(
      `SELECT event_type FROM outbox_message WHERE aggregate_id = $1`,
      [result.transactionId],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0].event_type).toBe('WagerTransactionProcessed');
  });

  it('replay WIN após outro crédito preserva snapshot original', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const input = {
      ...baseInput(playerId, wallet.id),
      amount: '20.00',
    };
    const first = await settleWin.execute(input);
    await settleWin.execute({
      ...baseInput(playerId, wallet.id),
      amount: '5.00',
    });

    const replay = await settleWin.execute(input);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.observedBalance).toBe('120.00');
    expect(replay.walletVersion).toBe(2);

    const row = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('125');
  });

  it('replay LOSS sem ledger e após BET posterior', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const input = {
      ...baseInput(playerId, wallet.id),
      amount: '0.00',
    };
    const first = await settleLoss.execute(input);

    await placeBet.execute({
      ...baseInput(playerId, wallet.id),
      amount: '30.00',
    });

    const replay = await settleLoss.execute(input);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.observedBalance).toBe('100.00');
    expect(replay.walletVersion).toBe(1);
  });

  it('idempotência concorrente WIN: um crédito', async () => {
    const { playerId, wallet } = await seedWallet('50.00');
    const input = {
      ...baseInput(playerId, wallet.id),
      amount: '10.00',
    };

    const results = await Promise.all([
      settleWin.execute(input),
      settleWin.execute(input),
    ]);

    expect(results[0].transactionId).toBe(results[1].transactionId);
    const txs = await connection.query(
      `SELECT id FROM wager_transaction WHERE wallet_id = $1 AND kind = 'WIN'`,
      [wallet.id],
    );
    expect(txs).toHaveLength(1);

    const row = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('60');
  });

  it('corrida WIN × BET na mesma carteira serializa corretamente', async () => {
    const { playerId, wallet } = await seedWallet('100.00');

    const results = await Promise.allSettled([
      settleWin.execute({
        ...baseInput(playerId, wallet.id),
        amount: '50.00',
      }),
      placeBet.execute({
        ...baseInput(playerId, wallet.id),
        amount: '80.00',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(2);

    const row = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    const balance = Number(String(row[0].balance));
    // 100+50-80=70 ou 100-80+50=70
    expect(balance).toBeCloseTo(70, 1);
    expect(row[0].version).toBe(3);
  });

  it('rollback se falhar ao persistir ledger da WIN', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const failing = new SettleWinUseCase({
      run: async (work) =>
        new TypeOrmUnitOfWork(connection).run(async (repos) => {
          const original = repos.ledgerEntries.save.bind(repos.ledgerEntries);
          repos.ledgerEntries.save = async (entry) => {
            await original(entry);
            throw new Error('falha forçada após ledger WIN');
          };
          return work(repos);
        }),
    });

    await expect(
      failing.execute({
        ...baseInput(playerId, wallet.id),
        amount: '15.00',
      }),
    ).rejects.toThrow('falha forçada após ledger WIN');

    const row = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('100');
    expect(row[0].version).toBe(1);

    const wins = await connection.query(
      `SELECT id FROM wager_transaction WHERE wallet_id = $1 AND kind = 'WIN'`,
      [wallet.id],
    );
    expect(wins).toHaveLength(0);
  });

  it('conflito de externalTransactionId na WIN', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const externalTransactionId = randomUUID();
    await settleWin.execute({
      ...baseInput(playerId, wallet.id),
      amount: '5.00',
      externalTransactionId,
    });

    await expect(
      settleWin.execute({
        ...baseInput(playerId, wallet.id),
        amount: '7.00',
        externalTransactionId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ExternalTransactionConflictForWinError);
  });

  it('LOSS mesma key com round diferente: conflito de payload', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const key = randomUUID();
    await settleLoss.execute({
      ...baseInput(playerId, wallet.id, { idempotencyKey: key, roundId: 'r1' }),
      amount: '0.00',
    });

    await expect(
      settleLoss.execute({
        ...baseInput(playerId, wallet.id, {
          idempotencyKey: key,
          roundId: 'r2',
          externalTransactionId: randomUUID(),
        }),
        amount: '0.00',
      }),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictForLossError);
  });
});
