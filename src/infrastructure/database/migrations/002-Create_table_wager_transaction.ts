import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWagerTransactionTable1761690001000
  implements MigrationInterface
{
  name = 'CreateWagerTransactionTable1761690001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "wager_transaction" (
        "id"                          uuid NOT NULL,
        "wallet_id"                   uuid NOT NULL,
        "player_id"                   uuid,
        "kind"                        character varying(32) NOT NULL,
        "status"                      character varying(32) NOT NULL,
        "amount"                      numeric(19,4) NOT NULL,
        "currency"                    character varying(3) NOT NULL,
        "provider_id"                 character varying(255),
        "external_transaction_id"     character varying(255),
        "idempotency_key"             character varying(255),
        "payload_hash"                character varying(128),
        "round_id"                    character varying(255),
        "game_id"                     character varying(255),
        "external_reference"          character varying(255),
        "resolved_internal_reference" uuid,
        "created_at"                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wager_transaction_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_wager_transaction_wallet"
          FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id"),
        CONSTRAINT "FK_wager_transaction_resolved_internal"
          FOREIGN KEY ("resolved_internal_reference")
          REFERENCES "wager_transaction"("id"),
        CONSTRAINT "CHK_wager_transaction_kind" CHECK (
          "kind" IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        CONSTRAINT "CHK_wager_transaction_status" CHECK (
          "status" IN (
            'PENDING',
            'PENDING_REFERENCE',
            'PROCESSED',
            'REJECTED',
            'FAILED'
          )
        ),
        CONSTRAINT "CHK_wager_transaction_currency_uppercase" CHECK (
          "currency" = UPPER("currency")
        ),
        CONSTRAINT "CHK_wager_transaction_amount_by_kind" CHECK (
          (
            "kind" = 'LOSS'
            AND "amount" = 0
          )
          OR (
            "kind" IN ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK')
            AND "amount" > 0
          )
        ),
        CONSTRAINT "CHK_wager_transaction_opening_processed" CHECK (
          "kind" <> 'OPENING' OR "status" = 'PROCESSED'
        ),
        CONSTRAINT "CHK_wager_transaction_opening_no_provider_meta" CHECK (
          "kind" <> 'OPENING'
          OR (
            "player_id" IS NULL
            AND "provider_id" IS NULL
            AND "external_transaction_id" IS NULL
            AND "idempotency_key" IS NULL
            AND "payload_hash" IS NULL
            AND "round_id" IS NULL
            AND "game_id" IS NULL
            AND "external_reference" IS NULL
            AND "resolved_internal_reference" IS NULL
          )
        ),
        CONSTRAINT "CHK_wager_transaction_external_requires_meta" CHECK (
          "kind" = 'OPENING'
          OR (
            "player_id" IS NOT NULL
            AND "provider_id" IS NOT NULL
            AND "external_transaction_id" IS NOT NULL
            AND "idempotency_key" IS NOT NULL
            AND "payload_hash" IS NOT NULL
            AND "round_id" IS NOT NULL
            AND "game_id" IS NOT NULL
          )
        ),
        CONSTRAINT "CHK_wager_transaction_refund_rollback_refs" CHECK (
          "kind" NOT IN ('REFUND', 'ROLLBACK')
          OR (
            "external_reference" IS NOT NULL
            AND "resolved_internal_reference" IS NOT NULL
          )
        )
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_wager_transaction_opening_wallet"
        ON "wager_transaction" ("wallet_id")
        WHERE "kind" = 'OPENING'
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_wager_transaction_provider_idempotency"
        ON "wager_transaction" ("provider_id", "idempotency_key")
        WHERE "kind" <> 'OPENING'
          AND "idempotency_key" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_wager_transaction_provider_external_id"
        ON "wager_transaction" ("provider_id", "external_transaction_id")
        WHERE "kind" <> 'OPENING'
          AND "external_transaction_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_wager_transaction_wallet_id"
        ON "wager_transaction" ("wallet_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_wager_transaction_player_id"
        ON "wager_transaction" ("player_id")
        WHERE "player_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trg_wager_transaction_currency_matches_wallet()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        wallet_currency character varying(3);
      BEGIN
        SELECT w."currency" INTO wallet_currency
        FROM "wallet" w
        WHERE w."id" = NEW."wallet_id";

        IF wallet_currency IS NULL THEN
          RAISE EXCEPTION 'wallet % não encontrada para wager_transaction', NEW."wallet_id";
        END IF;

        IF NEW."currency" IS DISTINCT FROM wallet_currency THEN
          RAISE EXCEPTION
            'currency da transação (%) difere da currency da wallet (%)',
            NEW."currency",
            wallet_currency;
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_wager_transaction_currency_matches_wallet
      BEFORE INSERT OR UPDATE OF "currency", "wallet_id"
      ON "wager_transaction"
      FOR EACH ROW
      EXECUTE FUNCTION trg_wager_transaction_currency_matches_wallet()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_wager_transaction_currency_matches_wallet
        ON "wager_transaction"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS trg_wager_transaction_currency_matches_wallet()
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_wager_transaction_player_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_wager_transaction_wallet_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wager_transaction_provider_external_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wager_transaction_provider_idempotency"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_wager_transaction_opening_wallet"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "wager_transaction"`);
  }
}
