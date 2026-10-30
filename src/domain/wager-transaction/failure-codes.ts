/**
 * Taxonomia de failureCode (estável, machine-readable).
 *
 * BET (já existente):
 * - INSUFFICIENT_FUNDS — saldo insuficiente para débito de aposta.
 *
 * REFUND / ROLLBACK:
 * - REFERENCE_NOT_FOUND — referência externa não encontrada (após esgotar
 *   PENDING_REFERENCE no worker futuro; neste bloco usamos PENDING_REFERENCE
 *   enquanto a referência está ausente).
 * - INVALID_REFERENCE_TYPE — kind da referência não permitido para a operação.
 * - REFERENCE_SCOPE_MISMATCH — provider/player/wallet/currency/round divergem.
 * - REFERENCE_AMOUNT_MISMATCH — amount ≠ amount da referência.
 * - REFERENCE_ALREADY_REVERSED — já existe reversão PROCESSED do mesmo tipo.
 * - REFERENCE_NOT_PROCESSED — referência existe mas não está PROCESSED.
 * - REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE — ROLLBACK débito deixaria saldo < 0.
 */
export const FAILURE_CODE_INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS' as const;
export const FAILURE_CODE_REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND' as const;
export const FAILURE_CODE_INVALID_REFERENCE_TYPE =
  'INVALID_REFERENCE_TYPE' as const;
export const FAILURE_CODE_REFERENCE_SCOPE_MISMATCH =
  'REFERENCE_SCOPE_MISMATCH' as const;
export const FAILURE_CODE_REFERENCE_AMOUNT_MISMATCH =
  'REFERENCE_AMOUNT_MISMATCH' as const;
export const FAILURE_CODE_REFERENCE_ALREADY_REVERSED =
  'REFERENCE_ALREADY_REVERSED' as const;
export const FAILURE_CODE_REFERENCE_NOT_PROCESSED =
  'REFERENCE_NOT_PROCESSED' as const;
export const FAILURE_CODE_REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE =
  'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE' as const;

export type WagerFailureCode =
  | typeof FAILURE_CODE_INSUFFICIENT_FUNDS
  | typeof FAILURE_CODE_REFERENCE_NOT_FOUND
  | typeof FAILURE_CODE_INVALID_REFERENCE_TYPE
  | typeof FAILURE_CODE_REFERENCE_SCOPE_MISMATCH
  | typeof FAILURE_CODE_REFERENCE_AMOUNT_MISMATCH
  | typeof FAILURE_CODE_REFERENCE_ALREADY_REVERSED
  | typeof FAILURE_CODE_REFERENCE_NOT_PROCESSED
  | typeof FAILURE_CODE_REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE;
