import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import { PlaceBetUseCase } from '../../src/application/use-cases/wager/place-bet.use-case';
import { IdempotencyPayloadConflictError } from '../../src/application/use-cases/wager/place-bet.errors';
import dataSource from '../../src/infrastructure/database/data-source';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';

describe('PlaceBetUseCase (e2e postgres)', () => {
  let connection: DataSource;
  let openWallet: OpenWalletUseCase;
  let placeBet: PlaceBetUseCase;
  const walletIds: string[] = [];

  beforeAll(async () => {
    connection = dataSource;
    if (!connection.isInitialized) {
      await connection.initialize();
    }
    const uow = new TypeOrmUnitOfWork(connection);
    openWallet = new OpenWalletUseCase(uow);
    placeBet = new PlaceBetUseCase(uow);
  });

  afterEach(async () => {
    if (walletIds.length === 0) {
      return;
    }

    // Limpeza em transação com role replica: triggers de usuário só nesta sessão.
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

  function betInput(
    playerId: string,
    walletId: string,
    amount: string,
    overrides: Record<string, string> = {},
  ) {
    return {
      providerId: 'provider-e2e',
      playerId,
      walletId,
      amount,
      currency: 'BRL',
      roundId: 'round-e2e',
      gameId: 'game-e2e',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      ...overrides,
    };
  }

  it('BET aprovada: saldo, tx, ledger e outbox coerentes', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const result = await placeBet.execute(
      betInput(playerId, wallet.id, '40.00'),
    );

    expect(result.status).toBe('PROCESSED');
    expect(result.observedBalance).toBe('60.00');

    const row = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('60');
    expect(row[0].version).toBe(2);

    const txs = await connection.query(
      `SELECT kind, status FROM wager_transaction WHERE id = $1`,
      [result.transactionId],
    );
    expect(txs[0]).toMatchObject({ kind: 'BET', status: 'PROCESSED' });

    const ledger = await connection.query(
      `SELECT direction FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [result.transactionId],
    );
    expect(ledger[0].direction).toBe('DEBIT');

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

  it('BET rejeitada por saldo: auditável sem alteração financeira', async () => {
    const { playerId, wallet } = await seedWallet('30.00');
    const result = await placeBet.execute(
      betInput(playerId, wallet.id, '50.00'),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');

    const row = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('30');
    expect(row[0].version).toBe(1);

    const betLedger = await connection.query(
      `SELECT id FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [result.transactionId],
    );
    expect(betLedger).toHaveLength(0);

    const balanceChangedForBet = await connection.query(
      `
        SELECT id FROM outbox_message
        WHERE event_type = 'WalletBalanceChanged'
          AND payload->'data'->>'transactionId' = $1::text
      `,
      [result.transactionId],
    );
    expect(balanceChangedForBet).toHaveLength(0);

    const outbox = await connection.query(
      `SELECT event_type, payload FROM outbox_message WHERE aggregate_id = $1`,
      [result.transactionId],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0].event_type).toBe('WagerTransactionRejected');
    expect(outbox[0].payload.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('duas BET concorrentes de 80 em carteira 100: só uma PROCESSED', async () => {
    const { playerId, wallet } = await seedWallet('100.00');

    const results = await Promise.allSettled([
      placeBet.execute(betInput(playerId, wallet.id, '80.00')),
      placeBet.execute(betInput(playerId, wallet.id, '80.00')),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<
      PromiseFulfilledResult<Awaited<ReturnType<PlaceBetUseCase['execute']>>>
    >;

    expect(fulfilled).toHaveLength(2);
    const statuses = fulfilled.map((r) => r.value.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const row = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('20');
  });

  it('duas BET concorrentes insuficientes (80+80 com saldo 50): ambas REJECTED', async () => {
    const { playerId, wallet } = await seedWallet('50.00');

    const results = await Promise.allSettled([
      placeBet.execute(betInput(playerId, wallet.id, '80.00')),
      placeBet.execute(betInput(playerId, wallet.id, '80.00')),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<
      PromiseFulfilledResult<Awaited<ReturnType<PlaceBetUseCase['execute']>>>
    >;

    expect(fulfilled).toHaveLength(2);
    expect(fulfilled.map((r) => r.value.status)).toEqual([
      'REJECTED',
      'REJECTED',
    ]);
    expect(fulfilled[0].value.transactionId).not.toBe(
      fulfilled[1].value.transactionId,
    );
    expect(fulfilled.every((r) => r.value.observedBalance === '50.00')).toBe(
      true,
    );

    const row = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('50');
    expect(row[0].version).toBe(1);

    const betLedger = await connection.query(
      `
        SELECT l.id
        FROM wallet_ledger_entry l
        JOIN wager_transaction t ON t.id = l.transaction_id
        WHERE t.wallet_id = $1 AND t.kind = 'BET'
      `,
      [wallet.id],
    );
    expect(betLedger).toHaveLength(0);

    const rejected = await connection.query(
      `
        SELECT id, status, failure_code
        FROM wager_transaction
        WHERE wallet_id = $1 AND kind = 'BET'
      `,
      [wallet.id],
    );
    expect(rejected).toHaveLength(2);
    expect(
      rejected.every(
        (r: { status: string; failure_code: string }) =>
          r.status === 'REJECTED' && r.failure_code === 'INSUFFICIENT_FUNDS',
      ),
    ).toBe(true);
  });

  it('mesma requisição concorrente: somente um débito e replay com IDs/saldo originais', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const input = betInput(playerId, wallet.id, '25.00');

    const results = await Promise.all([
      placeBet.execute(input),
      placeBet.execute(input),
    ]);

    expect(results[0].transactionId).toBe(results[1].transactionId);
    expect(results[0].walletId).toBe(results[1].walletId);
    expect(results[0].walletId).toBe(wallet.id);
    expect(results[0].observedBalance).toBe(results[1].observedBalance);
    expect(results[0].observedBalance).toBe('75.00');
    expect(results[0].status).toBe('PROCESSED');
    expect(results[1].status).toBe('PROCESSED');

    const txs = await connection.query(
      `SELECT id FROM wager_transaction WHERE wallet_id = $1 AND kind = 'BET'`,
      [wallet.id],
    );
    expect(txs).toHaveLength(1);

    const row = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('75');
  });

  it('mesma chave com payload diferente: conflito sem novo débito', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const key = randomUUID();
    await placeBet.execute(
      betInput(playerId, wallet.id, '10.00', { idempotencyKey: key }),
    );

    await expect(
      placeBet.execute(
        betInput(playerId, wallet.id, '20.00', {
          idempotencyKey: key,
          externalTransactionId: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);

    const row = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('90');
    expect(row[0].version).toBe(2);

    const bets = await connection.query(
      `SELECT id FROM wager_transaction WHERE wallet_id = $1 AND kind = 'BET'`,
      [wallet.id],
    );
    expect(bets).toHaveLength(1);
  });

  it('falha no meio da operação: rollback total', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const failing = new PlaceBetUseCase({
      run: async (work) =>
        new TypeOrmUnitOfWork(connection).run(async (repos) => {
          const original = repos.ledgerEntries.save.bind(repos.ledgerEntries);
          repos.ledgerEntries.save = async (entry) => {
            await original(entry);
            throw new Error('falha forçada após ledger');
          };
          return work(repos);
        }),
    });

    await expect(
      failing.execute(betInput(playerId, wallet.id, '15.00')),
    ).rejects.toThrow('falha forçada após ledger');

    const row = await connection.query(
      `SELECT balance::text AS balance, version FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(row[0].balance)).toContain('100');
    expect(row[0].version).toBe(1);

    const bets = await connection.query(
      `SELECT id FROM wager_transaction WHERE wallet_id = $1 AND kind = 'BET'`,
      [wallet.id],
    );
    expect(bets).toHaveLength(0);
  });
});
