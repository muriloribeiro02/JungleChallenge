import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Campos de falha/intervenção manual do Outbox.
 * Não altera 004/009; rollback remove só estas colunas/índice.
 */
export class OutboxInterventionFields1793389000000
  implements MigrationInterface
{
  name = 'OutboxInterventionFields1793389000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "outbox_message"
        ADD COLUMN "last_error" TEXT,
        ADD COLUMN "last_failed_at" TIMESTAMPTZ,
        ADD COLUMN "intervention_required_at" TIMESTAMPTZ
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_outbox_message_claimable_intervention"
        ON "outbox_message" ("occurred_at")
        WHERE "published_at" IS NULL
          AND "intervention_required_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_outbox_message_claimable_intervention"
    `);

    await queryRunner.query(`
      ALTER TABLE "outbox_message"
        DROP COLUMN IF EXISTS "intervention_required_at",
        DROP COLUMN IF EXISTS "last_failed_at",
        DROP COLUMN IF EXISTS "last_error"
    `);
  }
}
