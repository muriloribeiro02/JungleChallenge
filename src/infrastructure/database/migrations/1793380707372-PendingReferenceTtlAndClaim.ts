import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase C2 — TTL / backoff / claim de PENDING_REFERENCE.
 *
 * - pending_reference_at: momento em que entrou em PENDING_REFERENCE (TTL 24h).
 * - pending_attempt_count / next_attempt_at: backoff min(300, 2^n) s.
 * - locked_until: lease para claim multi-instância (FOR UPDATE SKIP LOCKED).
 *
 * Backfill: pendências existentes usam created_at como pending_reference_at.
 */
export class PendingReferenceTtlAndClaim1793380707372
  implements MigrationInterface
{
  name = 'PendingReferenceTtlAndClaim1793380707372';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ADD COLUMN IF NOT EXISTS "pending_reference_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "pending_attempt_count" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "next_attempt_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMPTZ
    `);

    await queryRunner.query(`
      UPDATE "wager_transaction"
      SET "pending_reference_at" = "created_at"
      WHERE "status" = 'PENDING_REFERENCE'
        AND "pending_reference_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wager_transaction_pending_claimable"
        ON "wager_transaction" ("pending_reference_at", "next_attempt_at")
        WHERE "status" = 'PENDING_REFERENCE'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_wager_transaction_pending_claimable"`,
    );
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        DROP COLUMN IF EXISTS "locked_until",
        DROP COLUMN IF EXISTS "next_attempt_at",
        DROP COLUMN IF EXISTS "pending_attempt_count",
        DROP COLUMN IF EXISTS "pending_reference_at"
    `);
  }
}
