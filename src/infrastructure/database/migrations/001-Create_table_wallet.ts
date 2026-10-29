import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWalletTable1761690000000 implements MigrationInterface {
  name = 'CreateWalletTable1761690000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "wallet" (
        "id"          uuid NOT NULL,
        "player_id"   uuid NOT NULL,
        "currency"    character varying(3) NOT NULL,
        "balance"     numeric(19,4) NOT NULL DEFAULT 0,
        "version"     integer NOT NULL DEFAULT 1,
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wallet_player_currency" UNIQUE ("player_id", "currency"),
        CONSTRAINT "CHK_wallet_currency_uppercase" CHECK (currency = UPPER(currency)),
        CONSTRAINT "CHK_wallet_balance_non_negative" CHECK (balance >= 0),
        CONSTRAINT "CHK_wallet_version_positive" CHECK (version >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_wallet_player_id" ON "wallet" ("player_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_wallet_player_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet"`);
  }
}
