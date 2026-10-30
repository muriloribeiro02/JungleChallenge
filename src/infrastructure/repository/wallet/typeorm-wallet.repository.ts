import type { Repository } from 'typeorm';
import type { Wallet } from '../../../domain/wallet/wallet.entity';
import type { WalletRepository } from '../../../domain/wallet/wallet.repository';
import { WalletMapper } from './wallet.mapper';
import { WalletOrmEntity } from './wallet.orm-entity';

export class TypeOrmWalletRepository implements WalletRepository {
  constructor(private readonly wallets: Repository<WalletOrmEntity>) {}

  async save(wallet: Wallet): Promise<void> {
    await this.wallets.save(WalletMapper.toPersistence(wallet));
  }

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.wallets.findOne({ where: { id } });
    if (!row) {
      return null;
    }
    return WalletMapper.toDomain(row);
  }
}
