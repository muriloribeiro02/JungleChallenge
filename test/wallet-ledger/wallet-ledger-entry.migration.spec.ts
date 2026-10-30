import type { QueryRunner } from 'typeorm';
import { CreateWalletLedgerEntryTable1761690002000 } from '../../src/infrastructure/database/migrations/003-Create_table_wallet_ledger_entry';

describe('CreateWalletLedgerEntryTable migration (unit)', () => {
  const migration = new CreateWalletLedgerEntryTable1761690002000();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    return { queryRunner, queries };
  }

  it('up cria ledger com UNIQUE, equação e triggers de imutabilidade', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.up(queryRunner);

    expect(
      queries.some((sql) => sql.includes('CREATE TABLE "wallet_ledger_entry"')),
    ).toBe(true);
    expect(
      queries.some((sql) =>
        sql.includes('UQ_wallet_ledger_entry_wallet_transaction'),
      ),
    ).toBe(true);
    expect(
      queries.some((sql) =>
        sql.includes('CHK_wallet_ledger_entry_balance_equation'),
      ),
    ).toBe(true);
    expect(
      queries.some((sql) => sql.includes('trg_wallet_ledger_entry_immutable')),
    ).toBe(true);
  });

  it('down remove triggers e tabela', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.down(queryRunner);

    expect(queries.some((sql) => sql.includes('DROP TRIGGER'))).toBe(true);
    expect(queries.at(-1)).toContain(
      'DROP TABLE IF EXISTS "wallet_ledger_entry"',
    );
  });
});
