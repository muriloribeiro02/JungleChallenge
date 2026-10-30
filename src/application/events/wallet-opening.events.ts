import { randomUUID } from 'node:crypto';
import type { Wallet } from '../../domain/wallet/wallet.entity';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction.entity';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger/wallet-ledger-entry.entity';
import type {
  WagerTransactionProcessedEvent,
  WalletBalanceChangedEvent,
} from '../../domain/outbox/domain-event';

const EVENT_ENVELOPE_VERSION = 1;

export function buildWagerTransactionProcessedEvent(input: {
  transaction: WagerTransaction;
  observedBalance: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}): WagerTransactionProcessedEvent {
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();
  const kind = input.transaction.kind;

  if (
    kind !== 'OPENING' &&
    kind !== 'BET' &&
    kind !== 'WIN' &&
    kind !== 'LOSS' &&
    kind !== 'REFUND' &&
    kind !== 'ROLLBACK'
  ) {
    throw new Error(`kind não suportado em Processed: ${kind}`);
  }

  return {
    eventId: randomUUID(),
    eventType: 'WagerTransactionProcessed',
    aggregateId: input.transaction.id,
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt,
    version: EVENT_ENVELOPE_VERSION,
    data: {
      transactionId: input.transaction.id,
      walletId: input.transaction.walletId,
      kind,
      status: 'PROCESSED',
      amount: input.transaction.amount.toString(),
      currency: input.transaction.amount.currency,
      observedBalance: input.observedBalance,
    },
  };
}

export function buildWalletBalanceChangedEvent(input: {
  wallet: Wallet;
  ledgerEntry: WalletLedgerEntry;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}): WalletBalanceChangedEvent {
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();

  return {
    eventId: randomUUID(),
    eventType: 'WalletBalanceChanged',
    aggregateId: input.wallet.id,
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt,
    version: EVENT_ENVELOPE_VERSION,
    data: {
      walletId: input.wallet.id,
      transactionId: input.ledgerEntry.transactionId,
      direction: input.ledgerEntry.direction,
      money: input.ledgerEntry.money.toJSON(),
      balanceBefore: input.ledgerEntry.balanceBefore.toJSON(),
      balanceAfter: input.ledgerEntry.balanceAfter.toJSON(),
      walletVersion: input.wallet.version,
    },
  };
}
