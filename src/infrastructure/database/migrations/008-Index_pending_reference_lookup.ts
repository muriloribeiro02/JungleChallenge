import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Índice parcial para localizar PENDING_REFERENCE por provider + external_reference.
 * Não altera invariantes; apenas acelera o reprocessamento.
 *
 * Decisão de implementação (não prescrita pelo contrato oficial).
 */
export class IndexPendingReferenceLookup1761690007000
  implements MigrationInterface
{
  name = 'IndexPendingReferenceLookup1761690007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "IDX_wager_transaction_pending_reference"
        ON "wager_transaction" (
          "provider_id",
          "external_reference",
          "created_at",
          "id"
        )
        WHERE "status" = 'PENDING_REFERENCE'
          AND "external_reference" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_wager_transaction_pending_reference"`,
    );
  }
}
