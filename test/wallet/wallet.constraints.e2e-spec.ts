import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { createDbClient, insertWallet } from '../helpers/db';

describe('wallet constraints', () => {
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

  it('aceita um registro válido', async () => {
    const result = await insertWallet(client, {
      currency: 'BRL',
      balance: '10.5000',
      version: 1,
    });

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].currency).toBe('BRL');
    expect(result.rows[0].balance).toBe('10.5000');
    expect(result.rows[0].version).toBe(1);
  });

  it('rejeita currency em minúsculo (CHK_wallet_currency_uppercase)', async () => {
    await expect(insertWallet(client, { currency: 'brl' })).rejects.toMatchObject(
      {
        code: '23514',
        constraint: 'CHK_wallet_currency_uppercase',
      },
    );
  });

  it('rejeita balance negativo (CHK_wallet_balance_non_negative)', async () => {
    await expect(
      insertWallet(client, { balance: '-0.0001' }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_wallet_balance_non_negative',
    });
  });

  it('rejeita version menor que 1 (CHK_wallet_version_positive)', async () => {
    await expect(insertWallet(client, { version: 0 })).rejects.toMatchObject({
      code: '23514',
      constraint: 'CHK_wallet_version_positive',
    });
  });

  it('rejeita player_id + currency duplicados (UQ_wallet_player_currency)', async () => {
    const playerId = randomUUID();

    await insertWallet(client, { playerId, currency: 'BRL' });

    await expect(
      insertWallet(client, { playerId, currency: 'BRL' }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'UQ_wallet_player_currency',
    });
  });

  it('permite o mesmo player_id com currencies diferentes', async () => {
    const playerId = randomUUID();

    await insertWallet(client, { playerId, currency: 'BRL' });
    const second = await insertWallet(client, { playerId, currency: 'USD' });

    expect(second.rowCount).toBe(1);
  });

  it('rejeita id duplicado (PK)', async () => {
    const id = randomUUID();

    await insertWallet(client, { id, currency: 'BRL' });

    await expect(
      insertWallet(client, { id, currency: 'USD' }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'PK_wallet_id',
    });
  });

  it('rejeita id nulo', async () => {
    await expect(
      client.query(
        `
          INSERT INTO wallet (id, player_id, currency, balance, version)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [null, randomUUID(), 'BRL', '0', 1],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('rejeita player_id nulo', async () => {
    await expect(
      client.query(
        `
          INSERT INTO wallet (id, player_id, currency, balance, version)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [randomUUID(), null, 'BRL', '0', 1],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('rejeita currency nula', async () => {
    await expect(
      client.query(
        `
          INSERT INTO wallet (id, player_id, currency, balance, version)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [randomUUID(), randomUUID(), null, '0', 1],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });
});
