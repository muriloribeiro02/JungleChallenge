import { QueryFailedError, type Repository } from 'typeorm';
import type { InboxMessage } from '../../../domain/inbox/inbox-message.entity';
import type { InboxMessageRepository } from '../../../domain/inbox/inbox-message.repository';
import { InboxMessageMapper } from './inbox-message.mapper';
import { InboxMessageOrmEntity } from './inbox-message.orm-entity';

export class TypeOrmInboxMessageRepository implements InboxMessageRepository {
  constructor(private readonly messages: Repository<InboxMessageOrmEntity>) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    try {
      await this.messages.insert(InboxMessageMapper.toPersistence(message));
      return true;
    } catch (error) {
      if (isPrimaryKeyViolation(error)) {
        return false;
      }
      throw error;
    }
  }

  async findById(id: string): Promise<InboxMessage | null> {
    const row = await this.messages.findOne({ where: { id } });
    return row ? InboxMessageMapper.toDomain(row) : null;
  }
}

function isPrimaryKeyViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError) && !(error && typeof error === 'object')) {
    return false;
  }
  const candidate = error as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const code = candidate.driverError?.code ?? candidate.code;
  if (code !== '23505') {
    return false;
  }
  const named =
    candidate.driverError?.constraint ?? candidate.constraint ?? '';
  return named === 'PK_inbox_message_id' || named.includes('inbox_message');
}
