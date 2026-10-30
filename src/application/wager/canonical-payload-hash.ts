/**
 * Policies/helpers compartilhados entre use cases de wager (não são use cases).
 */
import { createHash } from 'node:crypto';

/**
 * Campos de negócio do payload canônico (decisão da implementação).
 *
 * O contrato oficial exige JSON canônico com chaves ordenadas e exclusão de
 * Idempotency-Key / metadados de transporte, mas **não** fecha a lista de campos.
 *
 * Decisão desta implementação (documentada, não prescrita pelo contrato):
 * providerId, externalTransactionId, playerId, walletId, roundId, gameId,
 * kind, amount, currency.
 *
 * BET/WIN/LOSS mantêm o shape flat histórico (amount + currency) para não
 * alterar silenciosamente hashes já persistidos. REFUND/ROLLBACK incluem
 * referenceExternalTransactionId além dos mesmos campos base.
 */
export type ExternalWagerBusinessPayload = {
  providerId: string;
  playerId: string;
  walletId: string;
  amount: string;
  currency: string;
  roundId: string;
  gameId: string;
  externalTransactionId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  /** Presente somente em REFUND/ROLLBACK — não entra no hash de BET/WIN/LOSS. */
  referenceExternalTransactionId?: string;
};

export type BetBusinessPayload = ExternalWagerBusinessPayload & {
  kind: 'BET';
};

export type WinBusinessPayload = ExternalWagerBusinessPayload & {
  kind: 'WIN';
};

export type LossBusinessPayload = ExternalWagerBusinessPayload & {
  kind: 'LOSS';
};

export type RefundBusinessPayload = ExternalWagerBusinessPayload & {
  kind: 'REFUND';
  referenceExternalTransactionId: string;
};

export type RollbackBusinessPayload = ExternalWagerBusinessPayload & {
  kind: 'ROLLBACK';
  referenceExternalTransactionId: string;
};

/** JSON canônico com chaves ordenadas + SHA-256 hex. */
export function computeExternalWagerPayloadHash(
  payload: ExternalWagerBusinessPayload,
): string {
  const canonical = canonicalJsonStringify(payload);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function computeBetPayloadHash(payload: BetBusinessPayload): string {
  return computeExternalWagerPayloadHash(payload);
}

export function computeWinPayloadHash(payload: WinBusinessPayload): string {
  return computeExternalWagerPayloadHash(payload);
}

export function computeLossPayloadHash(payload: LossBusinessPayload): string {
  return computeExternalWagerPayloadHash(payload);
}

export function computeRefundPayloadHash(
  payload: RefundBusinessPayload,
): string {
  return computeExternalWagerPayloadHash(payload);
}

export function computeRollbackPayloadHash(
  payload: RollbackBusinessPayload,
): string {
  return computeExternalWagerPayloadHash(payload);
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}
