import type { QueryRunner } from 'typeorm';
import { CreateWalletTable1761690000000 } from '../../src/infrastructure/database/migrations/001-Create_table_wallet';

describe('CreateWalletTable migration (unit)', () => {
  const migration = new CreateWalletTable1761690000000();

  function createQueryRunnerMock() {
    const queries: string[] = [];
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;

    return { queryRunner, queries };
  }

  it('up cria a tabela wallet e o índice por player_id', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.up(queryRunner);

    expect(queryRunner.query).toHaveBeenCalledTimes(2);
    expect(queries[0]).toContain('CREATE TABLE "wallet"');
    expect(queries[0]).toContain('"balance"     numeric(19,4)');
    expect(queries[0]).toContain('CONSTRAINT "PK_wallet_id"');
    expect(queries[0]).toContain('CONSTRAINT "UQ_wallet_player_currency"');
    expect(queries[0]).toContain('CONSTRAINT "CHK_wallet_currency_uppercase"');
    expect(queries[0]).toContain('CONSTRAINT "CHK_wallet_balance_non_negative"');
    expect(queries[0]).toContain('CONSTRAINT "CHK_wallet_version_positive"');
    expect(queries[1]).toContain('CREATE INDEX "IDX_wallet_player_id"');
  });

  it('down remove o índice e a tabela wallet', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();

    await migration.down(queryRunner);

    expect(queryRunner.query).toHaveBeenCalledTimes(2);
    expect(queries[0]).toContain('DROP INDEX IF EXISTS "IDX_wallet_player_id"');
    expect(queries[1]).toContain('DROP TABLE IF EXISTS "wallet"');
  });
});
