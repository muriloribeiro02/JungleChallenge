import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import {
  createDbClient,
  insertExternalWagerTransaction,
  insertWallet,
  insertWagerTransaction,
} from '../helpers/db';

describe('wager_transaction constraints (postgres)', () => {
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

  async function seedWallet(currency = 'BRL') {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await insertWallet(client, { id: walletId, playerId, currency });
    return { walletId, playerId };
  }

  describe('status', () => {
    it.each(['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'])(
      'aceita status oficial %s em operação externa',
      async (status) => {
        const { walletId, playerId } = await seedWallet();

        const result = await insertExternalWagerTransaction(client, {
          walletId,
          playerId,
          status,
          kind: 'BET',
        });

        expect(result.rowCount).toBe(1);
        expect(result.rows[0].status).toBe(status);
      },
    );

    it('rejeita status inválido (CHK_wager_transaction_status)', async () => {
      const { walletId, playerId } = await seedWallet();

      await expect(
        insertExternalWagerTransaction(client, {
          walletId,
          playerId,
          status: 'CANCELLED',
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CHK_wager_transaction_status',
      });
    });

    it('OPENING exige status PROCESSED', async () => {
      const { walletId } = await seedWallet();

      await expect(
        insertWagerTransaction(client, {
          walletId,
          kind: 'OPENING',
          status: 'PENDING',
          amount: '100.0000',
          currency: 'BRL',
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CHK_wager_transaction_opening_processed',
      });
    });

    it('aceita OPENING com PROCESSED e amount positivo', async () => {
      const { walletId } = await seedWallet();

      const result = await insertWagerTransaction(client, {
        walletId,
        kind: 'OPENING',
        status: 'PROCESSED',
        amount: '100.0000',
        currency: 'BRL',
      });

      expect(result.rowCount).toBe(1);
    });
  });

  describe('amount por kind', () => {
    it('LOSS exige amount = 0', async () => {
      const { walletId, playerId } = await seedWallet();

      const ok = await insertExternalWagerTransaction(client, {
        walletId,
        playerId,
        kind: 'LOSS',
        amount: '0.0000',
      });
      expect(ok.rowCount).toBe(1);

      await expect(
        insertExternalWagerTransaction(client, {
          walletId,
          playerId,
          kind: 'LOSS',
          amount: '1.0000',
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CHK_wager_transaction_amount_by_kind',
      });
    });

    it.each(['BET', 'WIN', 'REFUND', 'ROLLBACK'] as const)(
      '%s rejeita amount = 0',
      async (kind) => {
        const { walletId, playerId } = await seedWallet();
        const refs =
          kind === 'REFUND' || kind === 'ROLLBACK'
            ? await insertExternalWagerTransaction(client, {
                walletId,
                playerId,
                kind: 'BET',
              })
            : null;

        await expect(
          insertExternalWagerTransaction(client, {
            walletId,
            playerId,
            kind,
            amount: '0.0000',
            externalReference:
              kind === 'REFUND' || kind === 'ROLLBACK' ? 'ext-ref' : null,
            resolvedInternalReference: refs?.rows[0].id ?? null,
          }),
        ).rejects.toMatchObject({
          code: '23514',
          constraint: 'CHK_wager_transaction_amount_by_kind',
        });
      },
    );

    it('OPENING rejeita amount = 0', async () => {
      const { walletId } = await seedWallet();

      await expect(
        insertWagerTransaction(client, {
          walletId,
          kind: 'OPENING',
          status: 'PROCESSED',
          amount: '0.0000',
          currency: 'BRL',
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'CHK_wager_transaction_amount_by_kind',
      });
    });
  });

  describe('idempotência e id externo por provedor', () => {
    it('rejeita mesma idempotency_key no mesmo provedor', async () => {
      const { walletId, playerId } = await seedWallet();
      const key = 'idem-1';

      await insertExternalWagerTransaction(client, {
        walletId,
        playerId,
        providerId: 'provider-a',
        idempotencyKey: key,
      });

      await expect(
        insertExternalWagerTransaction(client, {
          walletId,
          playerId,
          providerId: 'provider-a',
          idempotencyKey: key,
          externalTransactionId: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: '23505',
      });
    });

    it('permite a mesma idempotency_key em provedores diferentes', async () => {
      const { walletId, playerId } = await seedWallet();
      const key = 'idem-shared';

      await insertExternalWagerTransaction(client, {
        walletId,
        playerId,
        providerId: 'provider-a',
        idempotencyKey: key,
      });

      const second = await insertExternalWagerTransaction(client, {
        walletId,
        playerId,
        providerId: 'provider-b',
        idempotencyKey: key,
        externalTransactionId: randomUUID(),
      });

      expect(second.rowCount).toBe(1);
    });

    it('rejeita mesmo external_transaction_id no mesmo provedor', async () => {
      const { walletId, playerId } = await seedWallet();
      const externalId = 'ext-tx-1';

      await insertExternalWagerTransaction(client, {
        walletId,
        playerId,
        providerId: 'provider-a',
        externalTransactionId: externalId,
      });

      await expect(
        insertExternalWagerTransaction(client, {
          walletId,
          playerId,
          providerId: 'provider-a',
          externalTransactionId: externalId,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: '23505',
      });
    });
  });

  describe('moeda', () => {
    it('rejeita currency da transação diferente da wallet', async () => {
      const { walletId, playerId } = await seedWallet('BRL');

      await expect(
        insertExternalWagerTransaction(client, {
          walletId,
          playerId,
          currency: 'USD',
        }),
      ).rejects.toMatchObject({
        code: 'P0001',
      });
    });
  });
});
