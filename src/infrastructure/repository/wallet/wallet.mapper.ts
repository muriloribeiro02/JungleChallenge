import Decimal from 'decimal.js';
import { Wallet } from '../../../domain/wallet/wallet.entity';
import { WalletOrmEntity } from './wallet.orm-entity';

/**
 * Converte entre o Aggregate de domínio e o modelo de persistência TypeORM.
 * Normaliza balance lido do NUMERIC(19,4) para escala de 2 casas sem usar number.
 */
export class WalletMapper {
  static toPersistence(wallet: Wallet): WalletOrmEntity {
    const row = new WalletOrmEntity();
    row.id = wallet.id;
    row.playerId = wallet.playerId;
    row.currency = wallet.currency;
    row.balance = wallet.balance.toString();
    row.version = wallet.version;
    row.createdAt = wallet.createdAt;
    row.updatedAt = wallet.updatedAt;
    return row;
  }

  static toDomain(row: WalletOrmEntity): Wallet {
    const amount = new Decimal(row.balance).toFixed(2);

    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: {
        amount,
        currency: row.currency,
      },
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
