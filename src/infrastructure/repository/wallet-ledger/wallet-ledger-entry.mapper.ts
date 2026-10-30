import Decimal from 'decimal.js';
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

    const amount = new Decimal(row.amount).toFixed(2);
    const balanceBefore = new Decimal(row.balanceBefore).toFixed(2);
    const balanceAfter = new Decimal(row.balanceAfter).toFixed(2);

    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction,
      money: { amount, currency: row.currency },
      balanceBefore: { amount: balanceBefore, currency: row.currency },
      balanceAfter: { amount: balanceAfter, currency: row.currency },
      createdAt: row.createdAt,
    });
  }
}
