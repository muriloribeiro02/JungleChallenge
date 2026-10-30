import { Money } from '../../../domain/money/money';
import { Wallet } from '../../../domain/wallet/wallet.entity';
import { WalletOrmEntity } from './wallet.orm-entity';

/**
 * Converte entre o Aggregate de domínio e o modelo de persistência TypeORM.
 * Reidratação via Money.fromPersisted — rejeita precisão >2 com dígitos significativos
 * (sem arredondar 1.2350 → 1.24).
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
    const balance = Money.fromPersisted({
      amount: String(row.balance),
      currency: row.currency,
    });

    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: balance.toJSON(),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
