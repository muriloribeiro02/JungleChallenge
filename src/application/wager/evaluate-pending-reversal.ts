import type { Money } from '../../domain/money/money';
import {
  FAILURE_CODE_REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
  WAGER_TRANSACTION_TYPE_REFUND,
  WAGER_TRANSACTION_TYPE_ROLLBACK,
  WagerTransaction,
  type WagerFailureCode,
  type WagerTransaction as WagerTransactionEntity,
} from '../../domain/wager-transaction/wager-transaction.entity';
import {
  validateRefundReference,
  validateRollbackReference,
} from './validate-reversal-reference';

export type PendingReversalDecision =
  | { outcome: 'defer' }
  | { outcome: 'reject'; failureCode: WagerFailureCode }
  | { outcome: 'process'; direction: 'CREDIT' | 'DEBIT' };

/**
 * Reavalia uma pendência REFUND/ROLLBACK com as mesmas regras dos use cases
 * de criação. `defer` = referência ainda ausente (retry/TTL no use case).
 *
 * A rejeição por TTL (REFERENCE_NOT_FOUND) é responsabilidade do
 * ReprocessPendingReferencesUseCase após este defer — não inventa rejeição aqui.
 */
export function evaluatePendingReversal(input: {
  pending: WagerTransactionEntity;
  reference: WagerTransactionEntity | null;
  existingProcessedReversal: WagerTransactionEntity | null;
  walletBalance: Money;
}): PendingReversalDecision {
  const { pending, reference, existingProcessedReversal, walletBalance } =
    input;

  if (!reference) {
    return { outcome: 'defer' };
  }

  if (
    !pending.providerId ||
    !pending.playerId ||
    !pending.roundId ||
    !pending.externalReference
  ) {
    throw new Error('pendência REFUND/ROLLBACK sem metadados externos');
  }

  const scope = {
    providerId: pending.providerId,
    playerId: pending.playerId,
    walletId: pending.walletId,
    currency: pending.amount.currency,
    roundId: pending.roundId,
    amount: pending.amount,
  };

  if (pending.kind === WAGER_TRANSACTION_TYPE_REFUND) {
    const failureCode = validateRefundReference({
      reference,
      scope,
      existingProcessedRefund: existingProcessedReversal,
    });
    if (failureCode) {
      return { outcome: 'reject', failureCode };
    }
    return { outcome: 'process', direction: 'CREDIT' };
  }

  if (pending.kind === WAGER_TRANSACTION_TYPE_ROLLBACK) {
    const failureCode = validateRollbackReference({
      reference,
      scope,
      existingProcessedRollback: existingProcessedReversal,
    });
    if (failureCode) {
      return { outcome: 'reject', failureCode };
    }

    const direction = WagerTransaction.ledgerDirectionForRollback(
      reference.kind,
    );
    if (direction === 'DEBIT' && walletBalance.isLessThan(pending.amount)) {
      return {
        outcome: 'reject',
        failureCode: FAILURE_CODE_REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
      };
    }
    return { outcome: 'process', direction };
  }

  throw new Error(
    `kind não suportado no reprocessamento de pendência: ${pending.kind}`,
  );
}
