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

@Entity({ name: 'wallet_ledger_entry' })
export class WalletLedgerEntryOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ type: 'varchar', length: 8 })
  direction!: string;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 2,
    transformer: numericStringTransformer,
  })
  amount!: string;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({
    name: 'balance_before',
    type: 'numeric',
    precision: 19,
    scale: 2,
    transformer: numericStringTransformer,
  })
  balanceBefore!: string;

  @Column({
    name: 'balance_after',
    type: 'numeric',
    precision: 19,
    scale: 2,
    transformer: numericStringTransformer,
  })
  balanceAfter!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
