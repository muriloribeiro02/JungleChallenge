import type { QueryRunner } from 'typeorm';
import { AlignMonetaryNumericScaleNineteenTwo1793385791150 } from '../../src/infrastructure/database/migrations/1793385791150-AlignMonetaryNumericScaleNineteenTwo';

describe('AlignMonetaryNumericScaleNineteenTwo migration (unit)', () => {
  const migration = new AlignMonetaryNumericScaleNineteenTwo1793385791150();

  function createQueryRunnerMock(options?: {
    badCounts?: Record<string, number>;
  }) {
    const queries: string[] = [];
    const badCounts = options?.badCounts ?? {};
    const queryRunner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('COUNT(*)')) {
          for (const [needle, count] of Object.entries(badCounts)) {
            if (sql.includes(needle)) {
              return [{ c: count }];
            }
          }
          return [{ c: 0 }];
        }
        return undefined;
      }),
    } as unknown as QueryRunner;
    return { queryRunner, queries };
  }

  it('up aborta se existir valor com mais de 2 casas (sem arredondar)', async () => {
    const { queryRunner } = createQueryRunnerMock({
      badCounts: { 'FROM "wallet" WHERE "balance"': 2 },
    });
    await expect(migration.up(queryRunner)).rejects.toThrow(
      /mais de 2 casas decimais/,
    );
  });

  it('up altera colunas para numeric(19,2) quando dados estão limpos', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.up(queryRunner);
    const alters = queries.filter((q) => q.includes('ALTER COLUMN'));
    expect(alters.some((q) => q.includes('numeric(19,2)'))).toBe(true);
    expect(alters.some((q) => q.includes('"wallet"'))).toBe(true);
    expect(alters.some((q) => q.includes('"wager_transaction"'))).toBe(true);
    expect(alters.some((q) => q.includes('"wallet_ledger_entry"'))).toBe(true);
  });

  it('down restaura numeric(19,4)', async () => {
    const { queryRunner, queries } = createQueryRunnerMock();
    await migration.down(queryRunner);
    expect(queries.every((q) => q.includes('numeric(19,4)'))).toBe(true);
  });
});
