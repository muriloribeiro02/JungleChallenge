import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOutboxMessageTable1761690003000
  implements MigrationInterface
{
  name = 'CreateOutboxMessageTable1761690003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "outbox_message" (
        "id"               uuid NOT NULL,
        "aggregate_id"     uuid NOT NULL,
        "event_type"       character varying(128) NOT NULL,
        "payload"          jsonb NOT NULL,
        "occurred_at"      TIMESTAMPTZ NOT NULL,
        "attempts"         integer NOT NULL DEFAULT 0,
        "next_attempt_at"  TIMESTAMPTZ,
        "published_at"     TIMESTAMPTZ,
        CONSTRAINT "PK_outbox_message_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_outbox_message_attempts_non_negative" CHECK (
          "attempts" >= 0
        ),
        CONSTRAINT "CHK_outbox_message_payload_object" CHECK (
          jsonb_typeof("payload") = 'object'
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_outbox_message_aggregate_id"
        ON "outbox_message" ("aggregate_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_outbox_message_event_type"
        ON "outbox_message" ("event_type")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_outbox_message_unpublished"
        ON "outbox_message" ("next_attempt_at")
        WHERE "published_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trg_outbox_message_payload_immutable()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD."payload" IS DISTINCT FROM NEW."payload"
          OR OLD."aggregate_id" IS DISTINCT FROM NEW."aggregate_id"
          OR OLD."event_type" IS DISTINCT FROM NEW."event_type"
          OR OLD."occurred_at" IS DISTINCT FROM NEW."occurred_at"
          OR OLD."id" IS DISTINCT FROM NEW."id"
        THEN
          RAISE EXCEPTION
            'outbox_message: id, aggregate_id, event_type, payload e occurred_at são imutáveis';
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_outbox_message_payload_immutable
      BEFORE UPDATE ON "outbox_message"
      FOR EACH ROW
      EXECUTE FUNCTION trg_outbox_message_payload_immutable()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_outbox_message_payload_immutable
        ON "outbox_message"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS trg_outbox_message_payload_immutable()
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_outbox_message_unpublished"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_outbox_message_event_type"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_outbox_message_aggregate_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "outbox_message"`);
  }
}
