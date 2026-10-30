import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import { WalletAlreadyExistsError } from '../../src/domain/wallet/wallet.errors';
import dataSource from '../../src/infrastructure/database/data-source';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';

describe('OpenWalletUseCase (e2e postgres)', () => {
  let connection: DataSource;
  let useCase: OpenWalletUseCase;
  const createdWalletIds: string[] = [];

  beforeAll(async () => {
    connection = dataSource;
    if (!connection.isInitialized) {
      await connection.initialize();
    }
    useCase = new OpenWalletUseCase(new TypeOrmUnitOfWork(connection));
  });

  afterEach(async () => {
    if (createdWalletIds.length === 0) {
      return;
    }

    // Limpeza em transação com role replica (sem ALTER TABLE global no trigger).
    const qr = connection.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SET LOCAL session_replication_role = 'replica'`);
      await qr.query(
        `DELETE FROM outbox_message WHERE aggregate_id = ANY($1::uuid[])`,
        [createdWalletIds],
      );
      await qr.query(
        `
          DELETE FROM outbox_message
          WHERE aggregate_id IN (
            SELECT id FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])
          )
        `,
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
    if (connection?.isInitialized) {
      await connection.destroy();
    }
  });

  it('saldo zero persiste somente a carteira', async () => {
    const playerId = randomUUID();
    const result = await useCase.execute({
      playerId,
      currency: 'BRL',
      initialBalance: '0.00',
    });
    createdWalletIds.push(result.id);

    const wallets = await connection.query(
      `SELECT id, version, balance::text AS balance FROM wallet WHERE id = $1`,
      [result.id],
    );
    const txs = await connection.query(
      `SELECT id FROM wager_transaction WHERE wallet_id = $1`,
      [result.id],
    );
    const ledger = await connection.query(
      `SELECT id FROM wallet_ledger_entry WHERE wallet_id = $1`,
      [result.id],
    );
    const outbox = await connection.query(
      `SELECT id FROM outbox_message WHERE aggregate_id = $1`,
      [result.id],
    );

    expect(wallets).toHaveLength(1);
    expect(wallets[0].version).toBe(1);
    expect(String(wallets[0].balance)).toContain('0');
    expect(txs).toHaveLength(0);
    expect(ledger).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it('saldo positivo persiste wallet, OPENING, CREDIT e dois eventos no mesmo commit', async () => {
    const playerId = randomUUID();
    const result = await useCase.execute({
      playerId,
      currency: 'BRL',
      initialBalance: '100.00',
    });
    createdWalletIds.push(result.id);

    const txs = await connection.query(
      `
        SELECT id, kind, status, amount::text AS amount, currency
        FROM wager_transaction
        WHERE wallet_id = $1
      `,
      [result.id],
    );
    const ledger = await connection.query(
      `
        SELECT direction, amount::text AS amount, balance_before::text AS balance_before,
               balance_after::text AS balance_after, currency
        FROM wallet_ledger_entry
        WHERE wallet_id = $1
      `,
      [result.id],
    );
    const outbox = await connection.query(
      `
        SELECT event_type, aggregate_id, payload
        FROM outbox_message
        WHERE aggregate_id = $1
           OR aggregate_id = $2
        ORDER BY event_type
      `,
      [result.id, txs[0].id],
    );

    expect(txs).toHaveLength(1);
    expect(txs[0].kind).toBe('OPENING');
    expect(txs[0].status).toBe('PROCESSED');
    expect(String(txs[0].amount)).toContain('100');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].direction).toBe('CREDIT');
    expect(outbox).toHaveLength(2);
    expect(outbox.map((row: { event_type: string }) => row.event_type)).toEqual(
      ['WagerTransactionProcessed', 'WalletBalanceChanged'],
    );

    const processed = outbox.find(
      (row: { event_type: string }) =>
        row.event_type === 'WagerTransactionProcessed',
    );
    const balanceChanged = outbox.find(
      (row: { event_type: string }) =>
        row.event_type === 'WalletBalanceChanged',
    );

    expect(processed.aggregate_id).toBe(txs[0].id);
    expect(balanceChanged.aggregate_id).toBe(result.id);
    expect(balanceChanged.payload.data.walletVersion).toBe(1);
    expect(balanceChanged.payload.data.money.amount).toBe('100.00');
    expect(typeof balanceChanged.payload.data.money.amount).toBe('string');
  });

  it('duplicidade playerId+currency lança WalletAlreadyExistsError', async () => {
    const playerId = randomUUID();
    const first = await useCase.execute({
      playerId,
      currency: 'USD',
      initialBalance: '0.00',
    });
    createdWalletIds.push(first.id);

    await expect(
      useCase.execute({
        playerId,
        currency: 'USD',
        initialBalance: '5.00',
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  it('falha no meio do fluxo positivo faz rollback total no PostgreSQL', async () => {
    const playerId = randomUUID();
    const failingUow = new TypeOrmUnitOfWork(connection);
    const failingUseCase = new OpenWalletUseCase({
      run: async (work) =>
        failingUow.run(async (repos) => {
          const originalSave = repos.wagerTransactions.save.bind(
            repos.wagerTransactions,
          );
          repos.wagerTransactions.save = async (tx) => {
            await originalSave(tx);
            throw new Error('falha forçada após OPENING');
          };
          return work(repos);
        }),
    });

    await expect(
      failingUseCase.execute({
        playerId,
        currency: 'EUR',
        initialBalance: '25.00',
      }),
    ).rejects.toThrow('falha forçada após OPENING');

    const wallets = await connection.query(
      `SELECT id FROM wallet WHERE player_id = $1 AND currency = 'EUR'`,
      [playerId],
    );
    const txs = await connection.query(
      `
        SELECT t.id
        FROM wager_transaction t
        JOIN wallet w ON w.id = t.wallet_id
        WHERE w.player_id = $1 AND w.currency = 'EUR'
      `,
      [playerId],
    );

    expect(wallets).toHaveLength(0);
    expect(txs).toHaveLength(0);
  });
});
