import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Snapshot durável do resultado para replay idempotente.
 *
 * - Colunas nullable: não invalida OPENING/BET/REJECTED legados.
 * - Backfill de observed_balance apenas via ledger.balance_after (PROCESSED com lançamento).
 * - observed_wallet_version NÃO é preenchido por inferência nem via outbox.
 * - Sem CHECK de obrigatoriedade por status / NOT NULL.
 */
export class AddResultSnapshotToWagerTransaction1761690005000
  implements MigrationInterface
{
  name = 'AddResultSnapshotToWagerTransaction1761690005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ADD COLUMN "observed_balance" numeric(19,4),
        ADD COLUMN "observed_wallet_version" integer
    `);

    await queryRunner.query(`
      UPDATE "wager_transaction" AS t
      SET "observed_balance" = l."balance_after"
      FROM "wallet_ledger_entry" AS l
      WHERE l."transaction_id" = t."id"
        AND t."observed_balance" IS NULL
        AND t."status" = 'PROCESSED'
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ADD CONSTRAINT "CHK_wager_transaction_observed_balance_non_negative"
        CHECK ("observed_balance" IS NULL OR "observed_balance" >= 0)
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ADD CONSTRAINT "CHK_wager_transaction_observed_wallet_version_positive"
        CHECK (
          "observed_wallet_version" IS NULL
          OR "observed_wallet_version" >= 1
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        DROP CONSTRAINT IF EXISTS "CHK_wager_transaction_observed_wallet_version_positive"
    `);
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        DROP CONSTRAINT IF EXISTS "CHK_wager_transaction_observed_balance_non_negative"
    `);
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        DROP COLUMN IF EXISTS "observed_wallet_version",
        DROP COLUMN IF EXISTS "observed_balance"
    `);
  }
}
