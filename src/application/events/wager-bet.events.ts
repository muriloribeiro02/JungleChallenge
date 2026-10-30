import { randomUUID } from 'node:crypto';
import type {
  WagerTransactionRejectedEvent,
} from '../../domain/outbox/domain-event';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction.entity';
import { FAILURE_CODE_INSUFFICIENT_FUNDS } from '../../domain/wager-transaction/wager-transaction.entity';

const EVENT_ENVELOPE_VERSION = 1;

export function buildWagerTransactionRejectedEvent(input: {
  transaction: WagerTransaction;
  observedBalance: string;
  correlationId: string;
  causationId?: string;
  occurredAt?: Date;
}): WagerTransactionRejectedEvent {
  if (input.transaction.failureCode !== FAILURE_CODE_INSUFFICIENT_FUNDS) {
    throw new Error('failureCode inválido para WagerTransactionRejected');
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
      kind: 'BET',
      status: 'REJECTED',
      failureCode: FAILURE_CODE_INSUFFICIENT_FUNDS,
      amount: input.transaction.amount.toString(),
      currency: input.transaction.amount.currency,
      observedBalance: input.observedBalance,
    },
  };
}
