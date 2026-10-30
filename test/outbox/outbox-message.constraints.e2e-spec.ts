import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { createDbClient, insertOutboxMessage } from '../helpers/db';

/**
 * Decisão sobre DELETE em outbox_message:
 * O contrato local/oficial citado nesta etapa exige payload e campos de
 * envelope imutáveis, e permite atualizar campos operacionais
 * (attempts, next_attempt_at, published_at). Não determina proibição de DELETE.
 * Por isso a migration não bloqueia DELETE e este arquivo não inventa essa regra.
 */
describe('outbox_message constraints/triggers (postgres)', () => {
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

  it('aceita insert com envelope JSON objeto', async () => {
    const result = await insertOutboxMessage(client, {
      eventType: 'WalletBalanceChanged',
      payload: {
        version: 1,
        type: 'WalletBalanceChanged',
        data: { balance: '100.00' },
      },
    });

    expect(result.rowCount).toBe(1);
  });

  it('rejeita alteração de payload (imutável)', async () => {
    const inserted = await insertOutboxMessage(client);
    const id = inserted.rows[0].id;

    await expect(
      client.query(
        `UPDATE outbox_message SET payload = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ version: 2, type: 'x', data: {} }), id],
      ),
    ).rejects.toMatchObject({
      code: 'P0001',
    });
  });

  it('rejeita alteração de aggregate_id', async () => {
    const inserted = await insertOutboxMessage(client);

    await expect(
      client.query(
        `UPDATE outbox_message SET aggregate_id = $1 WHERE id = $2`,
        [randomUUID(), inserted.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  it('rejeita alteração de event_type', async () => {
    const inserted = await insertOutboxMessage(client);

    await expect(
      client.query(
        `UPDATE outbox_message SET event_type = $1 WHERE id = $2`,
        ['OtherEvent', inserted.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  it('rejeita alteração de occurred_at', async () => {
    const inserted = await insertOutboxMessage(client);

    await expect(
      client.query(
        `UPDATE outbox_message SET occurred_at = $1 WHERE id = $2`,
        [new Date('2020-01-01T00:00:00.000Z'), inserted.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  it('permite atualizar attempts, next_attempt_at e published_at', async () => {
    const inserted = await insertOutboxMessage(client);
    const id = inserted.rows[0].id;
    const nextAttempt = new Date('2026-10-30T12:00:00.000Z');
    const publishedAt = new Date('2026-10-30T12:05:00.000Z');

    const updated = await client.query(
      `
        UPDATE outbox_message
        SET attempts = $1, next_attempt_at = $2, published_at = $3
        WHERE id = $4
        RETURNING attempts, next_attempt_at, published_at, payload
      `,
      [3, nextAttempt, publishedAt, id],
    );

    expect(updated.rowCount).toBe(1);
    expect(updated.rows[0].attempts).toBe(3);
    expect(updated.rows[0].published_at).toEqual(publishedAt);
    expect(updated.rows[0].payload).toEqual(inserted.rows[0].payload);
  });
});
