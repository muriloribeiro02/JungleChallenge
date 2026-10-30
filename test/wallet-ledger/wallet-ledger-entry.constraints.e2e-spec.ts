import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import {
  createDbClient,
  insertExternalWagerTransaction,
  insertLedgerEntry,
  insertWallet,
  insertWagerTransaction,
} from '../helpers/db';

describe('wallet_ledger_entry constraints/triggers (postgres)', () => {
  let client: Client;

  beforeAll(async () => {
    client = createDbClient();
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  async function seedWalletAndOpening() {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await insertWallet(client, {
      id: walletId,
      playerId,
      currency: 'BRL',
      balance: '100.0000',
    });

    const opening = await insertWagerTransaction(client, {
      walletId,
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '100.0000',
      currency: 'BRL',
    });

    return { walletId, playerId, transactionId: opening.rows[0].id as string };
  }

  it('aceita crédito válido alinhado à wallet e à transação', async () => {
    const { walletId, transactionId } = await seedWalletAndOpening();

    const result = await insertLedgerEntry(client, {
      walletId,
      transactionId,
      direction: 'CREDIT',
      amount: '100.0000',
      currency: 'BRL',
      balanceBefore: '0.0000',
      balanceAfter: '100.0000',
    });

    expect(result.rowCount).toBe(1);
  });

  it('rejeita currency do ledger diferente da wallet/transação', async () => {
    const { walletId, transactionId } = await seedWalletAndOpening();

    await expect(
      insertLedgerEntry(client, {
        walletId,
        transactionId,
        amount: '100.0000',
        currency: 'USD',
        balanceBefore: '0.0000',
        balanceAfter: '100.0000',
      }),
    ).rejects.toMatchObject({
      code: 'P0001',
    });
  });

  it('rejeita lançamento de ledger para LOSS', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await insertWallet(client, { id: walletId, playerId, currency: 'BRL' });

    const loss = await insertExternalWagerTransaction(client, {
      walletId,
      playerId,
      kind: 'LOSS',
      amount: '0.0000',
    });

    await expect(
      insertLedgerEntry(client, {
        walletId,
        transactionId: loss.rows[0].id,
        amount: '10.0000',
        currency: 'BRL',
        balanceBefore: '10.0000',
        balanceAfter: '20.0000',
      }),
    ).rejects.toMatchObject({
      code: 'P0001',
    });
  });

  it('rejeita UPDATE no ledger (imutabilidade)', async () => {
    const { walletId, transactionId } = await seedWalletAndOpening();
    const entry = await insertLedgerEntry(client, {
      walletId,
      transactionId,
      amount: '100.0000',
      currency: 'BRL',
      balanceBefore: '0.0000',
      balanceAfter: '100.0000',
    });

    await expect(
      client.query(
        `UPDATE wallet_ledger_entry SET amount = $1 WHERE id = $2`,
        ['50.0000', entry.rows[0].id],
      ),
    ).rejects.toMatchObject({
      code: 'P0001',
    });
  });

  it('rejeita DELETE no ledger (imutabilidade)', async () => {
    const { walletId, transactionId } = await seedWalletAndOpening();
    const entry = await insertLedgerEntry(client, {
      walletId,
      transactionId,
      amount: '100.0000',
      currency: 'BRL',
      balanceBefore: '0.0000',
      balanceAfter: '100.0000',
    });

    await expect(
      client.query(`DELETE FROM wallet_ledger_entry WHERE id = $1`, [
        entry.rows[0].id,
      ]),
    ).rejects.toMatchObject({
      code: 'P0001',
    });
  });
});
