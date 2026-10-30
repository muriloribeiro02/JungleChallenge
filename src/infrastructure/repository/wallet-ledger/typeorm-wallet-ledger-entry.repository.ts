import type { Repository } from 'typeorm';
import type { WalletLedgerEntry } from '../../../domain/wallet-ledger/wallet-ledger-entry.entity';
import type { WalletLedgerEntryRepository } from '../../../domain/wallet-ledger/wallet-ledger-entry.repository';
import { WalletLedgerEntryMapper } from './wallet-ledger-entry.mapper';
import { WalletLedgerEntryOrmEntity } from './wallet-ledger-entry.orm-entity';

export class TypeOrmWalletLedgerEntryRepository
  implements WalletLedgerEntryRepository
{
  constructor(
    private readonly entries: Repository<WalletLedgerEntryOrmEntity>,
  ) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    await this.entries.save(WalletLedgerEntryMapper.toPersistence(entry));
  }
}
