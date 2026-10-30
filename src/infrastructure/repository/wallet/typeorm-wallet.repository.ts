import { QueryFailedError, type Repository } from 'typeorm';
import type { Wallet } from '../../../domain/wallet/wallet.entity';
import { WalletAlreadyExistsError } from '../../../domain/wallet/wallet.errors';
import type { WalletRepository } from '../../../domain/wallet/wallet.repository';
import { WalletMapper } from './wallet.mapper';
import { WalletOrmEntity } from './wallet.orm-entity';

export class TypeOrmWalletRepository implements WalletRepository {
  constructor(private readonly wallets: Repository<WalletOrmEntity>) {}

  async save(wallet: Wallet): Promise<void> {
    try {
      await this.wallets.save(WalletMapper.toPersistence(wallet));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.wallets.findOne({ where: { id } });
    if (!row) {
      return null;
    }
    return WalletMapper.toDomain(row);
  }

  /**
   * SELECT … FOR UPDATE — serializa débitos concorrentes na mesma carteira.
   * Escolha documentada: lock pessimista evita lost update sem retry de version.
   */
  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const row = await this.wallets
      .createQueryBuilder('wallet')
      .setLock('pessimistic_write')
      .where('wallet.id = :id', { id })
      .getOne();

    if (!row) {
      return null;
    }
    return WalletMapper.toDomain(row);
  }

  async findByPlayerIdAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const row = await this.wallets.findOne({
      where: { playerId, currency },
    });
    if (!row) {
      return null;
    }
    return WalletMapper.toDomain(row);
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof QueryFailedError) {
    const driverError = error.driverError as { code?: string } | undefined;
    return driverError?.code === '23505';
  }

  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code?: string }).code === '23505';
  }

  return false;
}
