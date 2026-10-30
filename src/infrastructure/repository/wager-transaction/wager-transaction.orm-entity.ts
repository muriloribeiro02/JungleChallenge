import { Column, Entity, PrimaryColumn } from 'typeorm';

const numericStringTransformer = {
  to: (value: string): string => value,
  from: (value: string | null): string => {
    if (value === null || value === undefined) {
      return '0.00';
    }
    return String(value);
  },
};

const nullableNumericStringTransformer = {
  to: (value: string | null): string | null => value,
  from: (value: string | null): string | null => {
    if (value === null || value === undefined) {
      return null;
    }
    return String(value);
  },
};

@Entity({ name: 'wager_transaction' })
export class WagerTransactionOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'player_id', type: 'uuid', nullable: true })
  playerId!: string | null;

  @Column({ type: 'varchar', length: 32 })
  kind!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: string;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 2,
    transformer: numericStringTransformer,
  })
  amount!: string;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ name: 'provider_id', type: 'varchar', length: 255, nullable: true })
  providerId!: string | null;

  @Column({
    name: 'external_transaction_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  externalTransactionId!: string | null;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  idempotencyKey!: string | null;

  @Column({
    name: 'payload_hash',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  payloadHash!: string | null;

  @Column({ name: 'round_id', type: 'varchar', length: 255, nullable: true })
  roundId!: string | null;

  @Column({ name: 'game_id', type: 'varchar', length: 255, nullable: true })
  gameId!: string | null;

  @Column({
    name: 'external_reference',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  externalReference!: string | null;

  @Column({
    name: 'resolved_internal_reference',
    type: 'uuid',
    nullable: true,
  })
  resolvedInternalReference!: string | null;

  @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode!: string | null;

  @Column({
    name: 'observed_balance',
    type: 'numeric',
    precision: 19,
    scale: 2,
    nullable: true,
    transformer: nullableNumericStringTransformer,
  })
  observedBalance!: string | null;

  @Column({
    name: 'observed_wallet_version',
    type: 'integer',
    nullable: true,
  })
  observedWalletVersion!: number | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({
    name: 'pending_reference_at',
    type: 'timestamptz',
    nullable: true,
  })
  pendingReferenceAt!: Date | null;

  @Column({
    name: 'pending_attempt_count',
    type: 'integer',
    default: 0,
  })
  pendingAttemptCount!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;
}
