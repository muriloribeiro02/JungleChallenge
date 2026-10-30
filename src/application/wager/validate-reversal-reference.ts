import type { Money } from '../../domain/money/money';
import {
  FAILURE_CODE_INVALID_REFERENCE_TYPE,
  FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
  FAILURE_CODE_REFERENCE_AMOUNT_MISMATCH,
  FAILURE_CODE_REFERENCE_NOT_PROCESSED,
  FAILURE_CODE_REFERENCE_SCOPE_MISMATCH,
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_TYPE_BET,
  WAGER_TRANSACTION_TYPE_REFUND,
  WAGER_TRANSACTION_TYPE_WIN,
  type WagerFailureCode,
  type WagerTransaction,
  type WagerTransactionKind,
} from '../../domain/wager-transaction/wager-transaction.entity';

export type ReversalReferenceScope = {
  providerId: string;
  playerId: string;
  walletId: string;
  currency: string;
  roundId: string;
  amount: Money;
};

const REFUND_ALLOWED: ReadonlySet<WagerTransactionKind> = new Set([
  WAGER_TRANSACTION_TYPE_BET,
]);

const ROLLBACK_ALLOWED: ReadonlySet<WagerTransactionKind> = new Set([
  WAGER_TRANSACTION_TYPE_BET,
  WAGER_TRANSACTION_TYPE_WIN,
  WAGER_TRANSACTION_TYPE_REFUND,
]);

/**
 * Valida referência para REFUND ou ROLLBACK (ordem estável dos failure codes).
 * Retorna null se válida.
 */
export function validateReversalReference(input: {
  reference: WagerTransaction;
  scope: ReversalReferenceScope;
  allowedKinds: ReadonlySet<WagerTransactionKind>;
  existingProcessedReversal: WagerTransaction | null;
}): WagerFailureCode | null {
  if (!input.allowedKinds.has(input.reference.kind)) {
    return FAILURE_CODE_INVALID_REFERENCE_TYPE;
  }

  if (input.reference.status !== WAGER_TRANSACTION_STATUS_PROCESSED) {
    return FAILURE_CODE_REFERENCE_NOT_PROCESSED;
  }

  if (
    input.reference.providerId !== input.scope.providerId ||
    input.reference.playerId !== input.scope.playerId ||
    input.reference.walletId !== input.scope.walletId ||
    input.reference.amount.currency !== input.scope.currency ||
    input.reference.roundId !== input.scope.roundId
  ) {
    return FAILURE_CODE_REFERENCE_SCOPE_MISMATCH;
  }

  if (!input.reference.amount.equals(input.scope.amount)) {
    return FAILURE_CODE_REFERENCE_AMOUNT_MISMATCH;
  }

  if (input.existingProcessedReversal) {
    return FAILURE_CODE_REFERENCE_ALREADY_REVERSED;
  }

  return null;
}

export function validateRefundReference(input: {
  reference: WagerTransaction;
  scope: ReversalReferenceScope;
  existingProcessedRefund: WagerTransaction | null;
}): WagerFailureCode | null {
  return validateReversalReference({
    reference: input.reference,
    scope: input.scope,
    allowedKinds: REFUND_ALLOWED,
    existingProcessedReversal: input.existingProcessedRefund,
  });
}

export function validateRollbackReference(input: {
  reference: WagerTransaction;
  scope: ReversalReferenceScope;
  existingProcessedRollback: WagerTransaction | null;
}): WagerFailureCode | null {
  return validateReversalReference({
    reference: input.reference,
    scope: input.scope,
    allowedKinds: ROLLBACK_ALLOWED,
    existingProcessedReversal: input.existingProcessedRollback,
  });
}
