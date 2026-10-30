import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alinha colunas monetárias a NUMERIC(19,2) — mesma escala do domínio Money.
 *
 * Limitação do PostgreSQL: ALTER / INSERT em NUMERIC(19,2) **arredonda**
 * valores com mais de 2 casas (não rejeita). Por isso:
 * 1) o `up` aborta se já existirem valores com fração além de 2 casas;
 * 2) a validação obrigatória permanece em Money / API (não confiar só no tipo).
 *
 * Não altera migrations 001–006; rollback restaura NUMERIC(19,4).
 */
export class AlignMonetaryNumericScaleNineteenTwo1793385791150
  implements MigrationInterface
{
  name = 'AlignMonetaryNumericScaleNineteenTwo1793385791150';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertNoExcessScale(queryRunner);

    await queryRunner.query(`
      ALTER TABLE "wallet"
        ALTER COLUMN "balance" TYPE numeric(19,2)
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ALTER COLUMN "amount" TYPE numeric(19,2),
        ALTER COLUMN "observed_balance" TYPE numeric(19,2)
    `);

    await queryRunner.query(`
      ALTER TABLE "wallet_ledger_entry"
        ALTER COLUMN "amount" TYPE numeric(19,2),
        ALTER COLUMN "balance_before" TYPE numeric(19,2),
        ALTER COLUMN "balance_after" TYPE numeric(19,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wallet_ledger_entry"
        ALTER COLUMN "amount" TYPE numeric(19,4),
        ALTER COLUMN "balance_before" TYPE numeric(19,4),
        ALTER COLUMN "balance_after" TYPE numeric(19,4)
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ALTER COLUMN "amount" TYPE numeric(19,4),
        ALTER COLUMN "observed_balance" TYPE numeric(19,4)
    `);

    await queryRunner.query(`
      ALTER TABLE "wallet"
        ALTER COLUMN "balance" TYPE numeric(19,4)
    `);
  }

  /**
   * `trunc(x, 2)` descarta casas além da 2ª sem arredondar.
   * Se x <> trunc(x, 2), há dígitos significativos na 3ª/4ª casa.
   */
  private async assertNoExcessScale(queryRunner: QueryRunner): Promise<void> {
    const checks: Array<{ label: string; sql: string }> = [
      {
        label: 'wallet.balance',
        sql: `SELECT COUNT(*)::int AS c FROM "wallet" WHERE "balance" <> trunc("balance", 2)`,
      },
      {
        label: 'wager_transaction.amount',
        sql: `SELECT COUNT(*)::int AS c FROM "wager_transaction" WHERE "amount" <> trunc("amount", 2)`,
      },
      {
        label: 'wager_transaction.observed_balance',
        sql: `SELECT COUNT(*)::int AS c FROM "wager_transaction"
              WHERE "observed_balance" IS NOT NULL
                AND "observed_balance" <> trunc("observed_balance", 2)`,
      },
      {
        label: 'wallet_ledger_entry.amount',
        sql: `SELECT COUNT(*)::int AS c FROM "wallet_ledger_entry" WHERE "amount" <> trunc("amount", 2)`,
      },
      {
        label: 'wallet_ledger_entry.balance_before',
        sql: `SELECT COUNT(*)::int AS c FROM "wallet_ledger_entry" WHERE "balance_before" <> trunc("balance_before", 2)`,
      },
      {
        label: 'wallet_ledger_entry.balance_after',
        sql: `SELECT COUNT(*)::int AS c FROM "wallet_ledger_entry" WHERE "balance_after" <> trunc("balance_after", 2)`,
      },
    ];

    const offenders: string[] = [];
    for (const check of checks) {
      const rows = (await queryRunner.query(check.sql)) as Array<{ c: number }>;
      const count = Number(rows[0]?.c ?? 0);
      if (count > 0) {
        offenders.push(`${check.label}=${count}`);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `AlignMonetaryNumericScaleNineteenTwo: existem valores com mais de 2 casas decimais (${offenders.join(', ')}). ` +
          'Corrija ou remova esses dados antes de migrar; a migration não arredonda silenciosamente.',
      );
    }
  }
}
