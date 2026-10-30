import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Necessário para persistir rejeições de negócio (ex.: INSUFFICIENT_FUNDS em BET REJECTED).
 * Não altera a migration 002; apenas adiciona coluna nullable.
 *
 * Escopo atual: failure_code obrigatório somente quando status = REJECTED.
 * Status FAILED (e outros) permanecem com failure_code NULL até haver regra
 * oficial — não implementamos comportamento FAILED nesta migration.
 * down remove a constraint e a coluna (reversível).
 */
export class AddFailureCodeToWagerTransaction1761690004000
  implements MigrationInterface
{
  name = 'AddFailureCodeToWagerTransaction1761690004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ADD COLUMN "failure_code" character varying(64)
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ADD CONSTRAINT "CHK_wager_transaction_failure_code_rejected"
        CHECK (
          ("status" = 'REJECTED' AND "failure_code" IS NOT NULL)
          OR ("status" <> 'REJECTED' AND "failure_code" IS NULL)
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        DROP CONSTRAINT IF EXISTS "CHK_wager_transaction_failure_code_rejected"
    `);
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        DROP COLUMN IF EXISTS "failure_code"
    `);
  }
}
