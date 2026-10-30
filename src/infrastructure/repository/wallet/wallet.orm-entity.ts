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

@Entity({ name: 'wallet' })
export class WalletOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 2,
    transformer: numericStringTransformer,
  })
  balance!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
