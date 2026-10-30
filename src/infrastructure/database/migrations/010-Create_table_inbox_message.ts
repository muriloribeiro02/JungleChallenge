import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inbox para deduplicação persistente de mensagens consumidas do SQS.
 * PK = eventId do envelope de domínio (identidade estável de negócio).
 *
 * Decisão de implementação: transport_message_id guarda o MessageId do SQS
 * apenas para observabilidade; a deduplicação usa id (= eventId).
 */
export class CreateInboxMessageTable1761690009000
  implements MigrationInterface
{
  name = 'CreateInboxMessageTable1761690009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "inbox_message" (
        "id"                   uuid NOT NULL,
        "event_type"           character varying(128) NOT NULL,
        "transport_message_id" character varying(255),
        "received_at"          TIMESTAMPTZ NOT NULL,
        "processed_at"         TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_inbox_message_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_inbox_message_event_type"
        ON "inbox_message" ("event_type")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_inbox_message_processed_at"
        ON "inbox_message" ("processed_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_inbox_message_processed_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_inbox_message_event_type"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "inbox_message"`);
  }
}
