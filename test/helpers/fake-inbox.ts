import type { InboxMessage } from '../../src/domain/inbox/inbox-message.entity';
import type { InboxMessageRepository } from '../../src/domain/inbox/inbox-message.repository';

export class FakeInboxRepository implements InboxMessageRepository {
  items: InboxMessage[] = [];

  async tryInsert(message: InboxMessage): Promise<boolean> {
    if (this.items.some((m) => m.id === message.id)) {
      return false;
    }
    this.items.push(message);
    return true;
  }

  async findById(id: string): Promise<InboxMessage | null> {
    return this.items.find((m) => m.id === id) ?? null;
  }
}
