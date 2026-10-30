import { InboxMessage } from '../../../domain/inbox/inbox-message.entity';
import { InboxMessageOrmEntity } from './inbox-message.orm-entity';

export class InboxMessageMapper {
  static toPersistence(message: InboxMessage): InboxMessageOrmEntity {
    const row = new InboxMessageOrmEntity();
    row.id = message.id;
    row.eventType = message.eventType;
    row.transportMessageId = message.transportMessageId;
    row.receivedAt = message.receivedAt;
    row.processedAt = message.processedAt;
    return row;
  }

  static toDomain(row: InboxMessageOrmEntity): InboxMessage {
    return InboxMessage.rehydrate({
      id: row.id,
      eventType: row.eventType,
      transportMessageId: row.transportMessageId,
      receivedAt: row.receivedAt,
      processedAt: row.processedAt,
    });
  }
}
