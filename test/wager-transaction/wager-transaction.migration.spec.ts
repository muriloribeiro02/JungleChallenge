import type { QueryRunner } from 'typeorm';
import { CreateWagerTransactionTable1761690001000 } from '../../src/infrastructure/database/migrations/002-Create_table_wager_transaction';

describe('CreateWagerTransactionTable migration (unit)', () => {
  const migration = new CreateWagerTransactionTable1761690001000();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    return { queryRunner, queries };
  }

  it('up cria tabela, índices parciais e trigger de currency', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.up(queryRunner);

    expect(queries.some((sql) => sql.includes('CREATE TABLE "wager_transaction"'))).toBe(
      true,
    );
    expect(queries.some((sql) => sql.includes('CHK_wager_transaction_kind'))).toBe(
      true,
    );
    expect(
      queries.some((sql) => sql.includes('UQ_wager_transaction_opening_wallet')),
    ).toBe(true);
    expect(
      queries.some((sql) =>
        sql.includes('UQ_wager_transaction_provider_idempotency'),
      ),
    ).toBe(true);
    expect(
      queries.some((sql) =>
        sql.includes('trg_wager_transaction_currency_matches_wallet'),
      ),
    ).toBe(true);
  });

  it('down remove trigger, índices e tabela', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.down(queryRunner);

    expect(queries[0]).toContain(
      'DROP TRIGGER IF EXISTS trg_wager_transaction_currency_matches_wallet',
    );
    expect(queries.at(-1)).toContain('DROP TABLE IF EXISTS "wager_transaction"');
  });
});
