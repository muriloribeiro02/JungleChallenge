import type { InboxMessage } from './inbox-message.entity';

export interface InboxMessageRepository {
  /**
   * Insere se não existir. Retorna true se inseriu (primeira vez),
   * false se já existia (duplicata).
   */
  tryInsert(message: InboxMessage): Promise<boolean>;
  findById(id: string): Promise<InboxMessage | null>;
}

export const INBOX_MESSAGE_REPOSITORY = Symbol('INBOX_MESSAGE_REPOSITORY');
