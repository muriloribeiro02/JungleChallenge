import { Money } from '../../../domain/money/money';
import {
  LEDGER_DIRECTION_CREDIT,
  LEDGER_DIRECTION_DEBIT,
  WalletLedgerEntry,
  type LedgerDirection,
} from '../../../domain/wallet-ledger/wallet-ledger-entry.entity';
import { WalletLedgerEntryOrmEntity } from './wallet-ledger-entry.orm-entity';

export class WalletLedgerEntryMapper {
  static toPersistence(entry: WalletLedgerEntry): WalletLedgerEntryOrmEntity {
    const row = new WalletLedgerEntryOrmEntity();
    row.id = entry.id;
    row.walletId = entry.walletId;
    row.transactionId = entry.transactionId;
    row.direction = entry.direction;
    row.amount = entry.money.toString();
    row.currency = entry.money.currency;
    row.balanceBefore = entry.balanceBefore.toString();
    row.balanceAfter = entry.balanceAfter.toString();
    row.createdAt = entry.createdAt;
    return row;
  }

  static toDomain(row: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
    const direction = row.direction as LedgerDirection;
    if (
      direction !== LEDGER_DIRECTION_CREDIT &&
      direction !== LEDGER_DIRECTION_DEBIT
    ) {
      throw new Error(
        `WalletLedgerEntryMapper.toDomain: direction inválida (${row.direction})`,
      );
    }

    const money = Money.fromPersisted({
      amount: String(row.amount),
      currency: row.currency,
    });
    const balanceBefore = Money.fromPersisted({
      amount: String(row.balanceBefore),
      currency: row.currency,
    });
    const balanceAfter = Money.fromPersisted({
      amount: String(row.balanceAfter),
      currency: row.currency,
    });

    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction,
      money: money.toJSON(),
      balanceBefore: balanceBefore.toJSON(),
      balanceAfter: balanceAfter.toJSON(),
      createdAt: row.createdAt,
    });
  }
}
