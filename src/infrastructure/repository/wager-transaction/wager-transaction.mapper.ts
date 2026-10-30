import Decimal from 'decimal.js';
import {
  WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_STATUS_REJECTED,
  WAGER_TRANSACTION_TYPE_BET,
  WAGER_TRANSACTION_TYPE_LOSS,
  WAGER_TRANSACTION_TYPE_OPENING,
  WAGER_TRANSACTION_TYPE_REFUND,
  WAGER_TRANSACTION_TYPE_ROLLBACK,
  WAGER_TRANSACTION_TYPE_WIN,
  WagerTransaction,
  type WagerFailureCode,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../../domain/wager-transaction/wager-transaction.entity';
import { WagerTransactionOrmEntity } from './wager-transaction.orm-entity';

const SUPPORTED_KINDS = new Set<string>([
  WAGER_TRANSACTION_TYPE_OPENING,
  WAGER_TRANSACTION_TYPE_BET,
  WAGER_TRANSACTION_TYPE_WIN,
  WAGER_TRANSACTION_TYPE_LOSS,
  WAGER_TRANSACTION_TYPE_REFUND,
  WAGER_TRANSACTION_TYPE_ROLLBACK,
]);

const SUPPORTED_STATUSES = new Set<string>([
  WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_STATUS_REJECTED,
]);

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
    row.externalReference = transaction.externalReference;
    row.resolvedInternalReference = transaction.resolvedInternalReference;
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

    if (!SUPPORTED_KINDS.has(kind)) {
      throw new Error(
        `WagerTransactionMapper.toDomain: kind não suportado (${row.kind})`,
      );
    }

    if (!SUPPORTED_STATUSES.has(status)) {
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
      externalReference: row.externalReference,
      resolvedInternalReference: row.resolvedInternalReference,
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
