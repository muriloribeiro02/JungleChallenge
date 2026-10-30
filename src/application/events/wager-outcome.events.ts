import { randomUUID } from 'node:crypto';
import type {
  WagerTransactionPendingReferenceEvent,
  WagerTransactionRejectedEvent,
} from '../../domain/events/domain-event';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction.entity';

const EVENT_ENVELOPE_VERSION = 1;

export function buildWagerTransactionRejectedEvent(input: {
  transaction: WagerTransaction;
  observedBalance: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}): WagerTransactionRejectedEvent {
  if (!input.transaction.failureCode) {
    throw new Error('failureCode obrigatório para WagerTransactionRejected');
  }

  const kind = input.transaction.kind;
  if (kind !== 'BET' && kind !== 'REFUND' && kind !== 'ROLLBACK') {
    throw new Error(`kind não suportado em Rejected: ${kind}`);
  }

  const occurredAt = (input.occurredAt ?? new Date()).toISOString();

  return {
    eventId: randomUUID(),
    eventType: 'WagerTransactionRejected',
    aggregateId: input.transaction.id,
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt,
    version: EVENT_ENVELOPE_VERSION,
    data: {
      transactionId: input.transaction.id,
      walletId: input.transaction.walletId,
      kind,
      status: 'REJECTED',
      failureCode: input.transaction.failureCode,
      amount: input.transaction.amount.toString(),
      currency: input.transaction.amount.currency,
      observedBalance: input.observedBalance,
    },
  };
}

export function buildWagerTransactionPendingReferenceEvent(input: {
  transaction: WagerTransaction;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}): WagerTransactionPendingReferenceEvent {
  const kind = input.transaction.kind;
  if (kind !== 'REFUND' && kind !== 'ROLLBACK') {
    throw new Error(`kind não suportado em PendingReference: ${kind}`);
  }
  if (!input.transaction.externalReference) {
    throw new Error('externalReference obrigatório para PendingReference');
  }

  const occurredAt = (input.occurredAt ?? new Date()).toISOString();

  return {
    eventId: randomUUID(),
    eventType: 'WagerTransactionPendingReference',
    aggregateId: input.transaction.id,
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt,
    version: EVENT_ENVELOPE_VERSION,
    data: {
      transactionId: input.transaction.id,
      walletId: input.transaction.walletId,
      kind,
      status: 'PENDING_REFERENCE',
      amount: input.transaction.amount.toString(),
      currency: input.transaction.amount.currency,
      externalReference: input.transaction.externalReference,
    },
  };
}
