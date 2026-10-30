import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * REFUND/ROLLBACK:
 * - PENDING_REFERENCE exige external_reference e resolved_internal_reference NULL.
 * - PROCESSED exige ambos preenchidos.
 * - REJECTED exige external_reference; resolved pode ser NULL (ex.: referência nunca encontrada).
 *
 * Unicidade: no máximo um REFUND PROCESSED e um ROLLBACK PROCESSED por
 * (provider_id, external_reference) — protege reversão duplicada sob concorrência.
 *
 * Justificativa: CHK da 002 exigia resolved sempre NOT NULL, incompatível com
 * PENDING_REFERENCE do contrato; não havia UNIQUE de reversão processada.
 */
export class RefundRollbackPendingAndUniqueReversal1761690006000
  implements MigrationInterface
{
  name = 'RefundRollbackPendingAndUniqueReversal1761690006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        DROP CONSTRAINT IF EXISTS "CHK_wager_transaction_refund_rollback_refs"
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ADD CONSTRAINT "CHK_wager_transaction_refund_rollback_refs"
        CHECK (
          "kind" NOT IN ('REFUND', 'ROLLBACK')
          OR (
            "external_reference" IS NOT NULL
            AND (
              (
                "status" = 'PENDING_REFERENCE'
                AND "resolved_internal_reference" IS NULL
              )
              OR (
                "status" = 'PROCESSED'
                AND "resolved_internal_reference" IS NOT NULL
              )
              OR (
                "status" = 'REJECTED'
              )
            )
          )
        )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_wager_transaction_refund_processed_ref"
        ON "wager_transaction" ("provider_id", "external_reference")
        WHERE "kind" = 'REFUND'
          AND "status" = 'PROCESSED'
          AND "external_reference" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_wager_transaction_rollback_processed_ref"
        ON "wager_transaction" ("provider_id", "external_reference")
        WHERE "kind" = 'ROLLBACK'
          AND "status" = 'PROCESSED'
          AND "external_reference" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wager_transaction_rollback_processed_ref"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wager_transaction_refund_processed_ref"`,
    );

    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        DROP CONSTRAINT IF EXISTS "CHK_wager_transaction_refund_rollback_refs"
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transaction"
        ADD CONSTRAINT "CHK_wager_transaction_refund_rollback_refs"
        CHECK (
          "kind" NOT IN ('REFUND', 'ROLLBACK')
          OR (
            "external_reference" IS NOT NULL
            AND "resolved_internal_reference" IS NOT NULL
          )
        )
    `);
  }
}
