import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Contrato §10: deduplicação Inbox por (consumerName, messageId).
 *
 * - consumer_name: distingue consumers (domain-events vs wager-inbound).
 * - id: passa de uuid para varchar — messageId do envelope pode não ser UUID
 *   (ex.: "msg-123" no contrato).
 *
 * down: só é seguro se todos os ids forem UUID válidos.
 */
export class InboxConsumerNameAndMessageId1761690011000
  implements MigrationInterface
{
  name = 'InboxConsumerNameAndMessageId1761690011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inbox_message"
        ADD COLUMN IF NOT EXISTS "consumer_name" character varying(128)
    `);

    await queryRunner.query(`
      UPDATE "inbox_message"
      SET "consumer_name" = 'domain-events'
      WHERE "consumer_name" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "inbox_message"
        ALTER COLUMN "consumer_name" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "inbox_message"
        DROP CONSTRAINT IF EXISTS "PK_inbox_message_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "inbox_message"
        ALTER COLUMN "id" TYPE character varying(255)
        USING "id"::text
    `);

    await queryRunner.query(`
      ALTER TABLE "inbox_message"
        ADD CONSTRAINT "PK_inbox_message_consumer_id"
        PRIMARY KEY ("consumer_name", "id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inbox_message"
        DROP CONSTRAINT IF EXISTS "PK_inbox_message_consumer_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "inbox_message"
        ALTER COLUMN "id" TYPE uuid USING "id"::uuid
    `);

    await queryRunner.query(`
      ALTER TABLE "inbox_message"
        ADD CONSTRAINT "PK_inbox_message_id" PRIMARY KEY ("id")
    `);

    await queryRunner.query(`
      ALTER TABLE "inbox_message"
        DROP COLUMN IF EXISTS "consumer_name"
    `);
  }
}
