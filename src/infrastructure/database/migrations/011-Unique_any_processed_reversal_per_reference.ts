import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase A / H1 — no máximo uma reversão PROCESSED (REFUND ou ROLLBACK) por
 * (provider_id, external_reference).
 *
 * Contrato (§7 tabela + §7.4 + invariante global de não duplicar créditos):
 * - §7.4 impede duas reversões do *mesmo tipo* (já coberto pela 007).
 * - REFUND reverte BET "uma única vez"; ROLLBACK reverte a referência "uma única vez".
 * - REFUND e ROLLBACK da *mesma* BET ambos creditam → crédito duplo.
 * - ROLLBACK de um REFUND permanece válido: external_reference aponta para o
 *   externalTransactionId do REFUND, não o da BET.
 *
 * Decisão documentada (contrato: "qualquer interpretação adicional deve ser
 * documentada"): unificar a unicidade em um único índice parcial cross-kind.
 *
 * down: restaura os dois índices por kind da 007.
 * Pré-condição do down: não pode existir par REFUND+ROLLBACK PROCESSED com o
 * mesmo (provider_id, external_reference) — após o up isso é impossível; se
 * dados ilegais forem inseridos manualmente, o down falha ao recriar índices.
 */
export class UniqueAnyProcessedReversalPerReference1761690010000
  implements MigrationInterface
{
  name = 'UniqueAnyProcessedReversalPerReference1761690010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wager_transaction_refund_processed_ref"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wager_transaction_rollback_processed_ref"`,
    );

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_wager_transaction_processed_reversal_ref"
        ON "wager_transaction" ("provider_id", "external_reference")
        WHERE "kind" IN ('REFUND', 'ROLLBACK')
          AND "status" = 'PROCESSED'
          AND "external_reference" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wager_transaction_processed_reversal_ref"`,
    );

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
}
