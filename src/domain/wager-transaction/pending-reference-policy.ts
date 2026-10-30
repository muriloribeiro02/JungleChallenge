/** TTL definitivo (Fase C2): 24h a partir de pending_reference_at. */
export const PENDING_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Backoff de reavaliação: min(300, 2^n) segundos.
 * `n` = pending_attempt_count **após** o defer (incremento em recordDeferRetry).
 * Sem teto adicional de tentativas — o TTL encerra.
 */
export function computePendingNextAttemptAt(
  attemptCount: number,
  now: Date = new Date(),
): Date {
  const delaySeconds = Math.min(300, 2 ** Math.max(1, attemptCount));
  return new Date(now.getTime() + delaySeconds * 1000);
}

export function isPendingReferenceExpired(
  pendingReferenceAt: Date,
  now: Date = new Date(),
): boolean {
  return (
    now.getTime() - pendingReferenceAt.getTime() >= PENDING_REFERENCE_TTL_MS
  );
}
