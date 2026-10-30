/**
 * Limiar de intervenção manual no Outbox.
 *
 * `attempts` é incrementado no **claim** (não só em falha de publish).
 * Portanto pode incluir claims abandonados por crash/shutdown/lease expirado,
 * além de falhas confirmadas de publicação.
 */
export const OUTBOX_INTERVENTION_ATTEMPT_THRESHOLD = 10;

export function shouldRequireOutboxIntervention(attempts: number): boolean {
  return attempts >= OUTBOX_INTERVENTION_ATTEMPT_THRESHOLD;
}
