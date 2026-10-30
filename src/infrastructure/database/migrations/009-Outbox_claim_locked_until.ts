import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Claim/lease para publishers concorrentes (FOR UPDATE SKIP LOCKED + locked_until).
 * Campo operacional; payload permanece imutável (trigger 004).
 *
 * Decisão de implementação: lease explícito para liberar após crash sem
 * esperar o fim da transação SQL que segura o lock de linha.
 */
export class OutboxClaimLockedUntil1761690008000 implements MigrationInterface {
  name = 'OutboxClaimLockedUntil1761690008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "outbox_message"
        ADD COLUMN "locked_until" TIMESTAMPTZ
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_outbox_message_claimable"
        ON "outbox_message" ("occurred_at")
        WHERE "published_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_outbox_message_claimable"`,
    );
    await queryRunner.query(`
      ALTER TABLE "outbox_message"
        DROP COLUMN IF EXISTS "locked_until"
    `);
  }
}
