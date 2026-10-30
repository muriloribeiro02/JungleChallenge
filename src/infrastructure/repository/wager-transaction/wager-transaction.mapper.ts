import Decimal from 'decimal.js';
import {
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_STATUS_REJECTED,
  WAGER_TRANSACTION_TYPE_BET,
  WAGER_TRANSACTION_TYPE_OPENING,
  WagerTransaction,
  type WagerFailureCode,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../../domain/wager-transaction/wager-transaction.entity';
import { WagerTransactionOrmEntity } from './wager-transaction.orm-entity';

export class WagerTransactionMapper {
  static toPersistence(
    transaction: WagerTransaction,
  ): WagerTransactionOrmEntity {
    const row = new WagerTransactionOrmEntity();
    row.id = transaction.id;
    row.walletId = transaction.walletId;
    row.playerId = transaction.playerId;
    row.kind = transaction.kind;
    row.status = transaction.status;
    row.amount = transaction.amount.toString();
    row.currency = transaction.amount.currency;
    row.providerId = transaction.providerId;
    row.externalTransactionId = transaction.externalTransactionId;
    row.idempotencyKey = transaction.idempotencyKey;
    row.payloadHash = transaction.payloadHash;
    row.roundId = transaction.roundId;
    row.gameId = transaction.gameId;
    row.externalReference = null;
    row.resolvedInternalReference = null;
    row.failureCode = transaction.failureCode;
    row.observedBalance = transaction.observedBalance?.toString() ?? null;
    row.observedWalletVersion = transaction.observedWalletVersion;
    row.createdAt = transaction.createdAt;
    row.updatedAt = transaction.updatedAt;
    return row;
  }

  static toDomain(row: WagerTransactionOrmEntity): WagerTransaction {
    const kind = row.kind as WagerTransactionKind;
    const status = row.status as WagerTransactionStatus;

    if (
      kind !== WAGER_TRANSACTION_TYPE_OPENING &&
      kind !== WAGER_TRANSACTION_TYPE_BET
    ) {
      throw new Error(
        `WagerTransactionMapper.toDomain: kind não suportado (${row.kind})`,
      );
    }

    if (
      status !== WAGER_TRANSACTION_STATUS_PROCESSED &&
      status !== WAGER_TRANSACTION_STATUS_REJECTED
    ) {
      throw new Error(
        `WagerTransactionMapper.toDomain: status não suportado (${row.status})`,
      );
    }

    const amount = new Decimal(row.amount).toFixed(2);

    return WagerTransaction.rehydrate({
      id: row.id,
      walletId: row.walletId,
      playerId: row.playerId,
      type: kind,
      status,
      amount: {
        amount,
        currency: row.currency,
      },
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      idempotencyKey: row.idempotencyKey,
      payloadHash: row.payloadHash,
      roundId: row.roundId,
      gameId: row.gameId,
      failureCode: (row.failureCode as WagerFailureCode | null) ?? null,
      observedBalance:
        row.observedBalance === null
          ? null
          : {
              amount: new Decimal(row.observedBalance).toFixed(2),
              currency: row.currency,
            },
      observedWalletVersion: row.observedWalletVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
