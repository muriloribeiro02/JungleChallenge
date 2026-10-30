import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWalletLedgerEntryTable1761690002000
  implements MigrationInterface
{
  name = 'CreateWalletLedgerEntryTable1761690002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "wallet_ledger_entry" (
        "id"              uuid NOT NULL,
        "wallet_id"       uuid NOT NULL,
        "transaction_id"  uuid NOT NULL,
        "direction"       character varying(8) NOT NULL,
        "amount"          numeric(19,4) NOT NULL,
        "currency"        character varying(3) NOT NULL,
        "balance_before"  numeric(19,4) NOT NULL,
        "balance_after"   numeric(19,4) NOT NULL,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_ledger_entry_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_wallet_ledger_entry_wallet"
          FOREIGN KEY ("wallet_id") REFERENCES "wallet"("id"),
        CONSTRAINT "FK_wallet_ledger_entry_transaction"
          FOREIGN KEY ("transaction_id") REFERENCES "wager_transaction"("id"),
        CONSTRAINT "UQ_wallet_ledger_entry_wallet_transaction"
          UNIQUE ("wallet_id", "transaction_id"),
        CONSTRAINT "CHK_wallet_ledger_entry_direction" CHECK (
          "direction" IN ('CREDIT', 'DEBIT')
        ),
        CONSTRAINT "CHK_wallet_ledger_entry_currency_uppercase" CHECK (
          "currency" = UPPER("currency")
        ),
        CONSTRAINT "CHK_wallet_ledger_entry_amount_positive" CHECK (
          "amount" > 0
        ),
        CONSTRAINT "CHK_wallet_ledger_entry_balances_non_negative" CHECK (
          "balance_before" >= 0 AND "balance_after" >= 0
        ),
        CONSTRAINT "CHK_wallet_ledger_entry_balance_equation" CHECK (
          (
            "direction" = 'CREDIT'
            AND "balance_after" = "balance_before" + "amount"
          )
          OR (
            "direction" = 'DEBIT'
            AND "balance_after" = "balance_before" - "amount"
          )
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_wallet_ledger_entry_wallet_id"
        ON "wallet_ledger_entry" ("wallet_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_wallet_ledger_entry_transaction_id"
        ON "wallet_ledger_entry" ("transaction_id")
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trg_wallet_ledger_entry_immutable()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION
          'wallet_ledger_entry é imutável: UPDATE e DELETE são proibidos';
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_wallet_ledger_entry_immutable
      BEFORE UPDATE OR DELETE ON "wallet_ledger_entry"
      FOR EACH ROW
      EXECUTE FUNCTION trg_wallet_ledger_entry_immutable()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION trg_wallet_ledger_entry_currency_consistency()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        wallet_currency character varying(3);
        tx_currency character varying(3);
        tx_kind character varying(32);
      BEGIN
        SELECT w."currency" INTO wallet_currency
        FROM "wallet" w
        WHERE w."id" = NEW."wallet_id";

        IF wallet_currency IS NULL THEN
          RAISE EXCEPTION 'wallet % não encontrada para ledger', NEW."wallet_id";
        END IF;

        SELECT t."currency", t."kind" INTO tx_currency, tx_kind
        FROM "wager_transaction" t
        WHERE t."id" = NEW."transaction_id";

        IF tx_currency IS NULL THEN
          RAISE EXCEPTION
            'wager_transaction % não encontrada para ledger',
            NEW."transaction_id";
        END IF;

        IF tx_kind = 'LOSS' THEN
          RAISE EXCEPTION
            'transação LOSS (%) não pode gerar lançamento no ledger',
            NEW."transaction_id";
        END IF;

        IF NEW."currency" IS DISTINCT FROM wallet_currency THEN
          RAISE EXCEPTION
            'currency do ledger (%) difere da currency da wallet (%)',
            NEW."currency",
            wallet_currency;
        END IF;

        IF NEW."currency" IS DISTINCT FROM tx_currency THEN
          RAISE EXCEPTION
            'currency do ledger (%) difere da currency da transação (%)',
            NEW."currency",
            tx_currency;
        END IF;

        IF NEW."wallet_id" IS DISTINCT FROM (
          SELECT t."wallet_id"
          FROM "wager_transaction" t
          WHERE t."id" = NEW."transaction_id"
        ) THEN
          RAISE EXCEPTION
            'wallet_id do ledger não corresponde à wallet_id da transação';
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_wallet_ledger_entry_currency_consistency
      BEFORE INSERT ON "wallet_ledger_entry"
      FOR EACH ROW
      EXECUTE FUNCTION trg_wallet_ledger_entry_currency_consistency()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_wallet_ledger_entry_currency_consistency
        ON "wallet_ledger_entry"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS trg_wallet_ledger_entry_currency_consistency()
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_wallet_ledger_entry_immutable
        ON "wallet_ledger_entry"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS trg_wallet_ledger_entry_immutable()
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_wallet_ledger_entry_transaction_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_wallet_ledger_entry_wallet_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_ledger_entry"`);
  }
}
