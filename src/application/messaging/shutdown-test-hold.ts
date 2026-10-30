/**
 * Probe de teste para drenagem real (C3).
 * `SHUTDOWN_TEST_HOLD_MS` > 0 bloqueia de forma ininterrupta (ignora stopping)
 * para forçar `shutdown.drain_timeout` com processo/container real.
 * Em produção o env fica ausente/0 — no-op.
 */
export async function applyShutdownTestHoldIfConfigured(): Promise<void> {
  const ms = Number(process.env.SHUTDOWN_TEST_HOLD_MS ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(ms)));
}
