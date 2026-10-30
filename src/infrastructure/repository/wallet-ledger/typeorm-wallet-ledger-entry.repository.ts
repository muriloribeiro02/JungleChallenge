import type { Repository } from 'typeorm';
import type { WalletLedgerEntry } from '../../../domain/wallet-ledger/wallet-ledger-entry.entity';
import type {
  LedgerListPage,
  WalletLedgerEntryRepository,
} from '../../../domain/wallet-ledger/wallet-ledger-entry.repository';
import { WalletLedgerEntryMapper } from './wallet-ledger-entry.mapper';
import { WalletLedgerEntryOrmEntity } from './wallet-ledger-entry.orm-entity';

type CursorPayload = { createdAt: string; id: string };

export class TypeOrmWalletLedgerEntryRepository
  implements WalletLedgerEntryRepository
{
  constructor(
    private readonly entries: Repository<WalletLedgerEntryOrmEntity>,
  ) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    await this.entries.save(WalletLedgerEntryMapper.toPersistence(entry));
  }

  async listByWalletId(
    walletId: string,
    options: { cursor?: string | null; limit: number },
  ): Promise<LedgerListPage> {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    const qb = this.entries
      .createQueryBuilder('e')
      .where('e.wallet_id = :walletId', { walletId })
      .orderBy('e.created_at', 'ASC')
      .addOrderBy('e.id', 'ASC')
      .take(limit + 1);

    const cursor = decodeCursor(options.cursor);
    if (cursor) {
      qb.andWhere(
        '(e.created_at > :createdAt OR (e.created_at = :createdAt AND e.id > :id))',
        { createdAt: cursor.createdAt, id: cursor.id },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) => WalletLedgerEntryMapper.toDomain(row));
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null;

    return { items, nextCursor };
  }

  async listAllByWalletId(walletId: string): Promise<WalletLedgerEntry[]> {
    const rows = await this.entries.find({
      where: { walletId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return rows.map((row) => WalletLedgerEntryMapper.toDomain(row));
  }

  async countByWalletId(walletId: string): Promise<number> {
    return this.entries.count({ where: { walletId } });
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string | null): CursorPayload | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as CursorPayload;
    if (
      typeof parsed?.createdAt !== 'string' ||
      typeof parsed?.id !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
