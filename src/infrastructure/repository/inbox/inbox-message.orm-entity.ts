import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'inbox_message' })
export class InboxMessageOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 128 })
  eventType!: string;

  @Column({
    name: 'transport_message_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  transportMessageId!: string | null;

  @Column({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz' })
  processedAt!: Date;
}
