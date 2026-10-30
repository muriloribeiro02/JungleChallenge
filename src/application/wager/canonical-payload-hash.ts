import { createHash } from 'node:crypto';

/**
 * Campos de negócio incluídos no hash (sem headers/transporte como idempotencyKey).
 *
 * Pendência: não há no repositório (README/COMOPENSEI) a lista oficial fechada dos
 * campos do payload canônico. Mantemos o conjunto alinhado às regras de BET já
 * confirmadas na implementação (metadados externos + valor/moeda/kind), excluindo
 * idempotencyKey e demais metadados de transporte. Revisar quando o contrato
 * oficial de hashing estiver disponível no projeto.
 */
export type BetBusinessPayload = {
  providerId: string;
  playerId: string;
  walletId: string;
  amount: string;
  currency: string;
  roundId: string;
  gameId: string;
  externalTransactionId: string;
  kind: 'BET';
};

/** JSON canônico com chaves ordenadas + SHA-256 hex. */
export function computeBetPayloadHash(payload: BetBusinessPayload): string {
  const canonical = canonicalJsonStringify(payload);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
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
