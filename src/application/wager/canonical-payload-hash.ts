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
 * BET mantém o shape flat histórico (amount + currency) para não alterar
 * silenciosamente hashes já persistidos. WIN/LOSS usam o mesmo conjunto de
 * campos e o mesmo algoritmo, apenas com kind distinto.
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
  kind: 'BET' | 'WIN' | 'LOSS';
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
