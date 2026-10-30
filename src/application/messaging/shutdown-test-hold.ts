import { optionalNonNegativeInt } from '../../shared/parse-env-int';

/**
 * Probe de teste para drenagem real (C3).
 * `SHUTDOWN_TEST_HOLD_MS` > 0 bloqueia de forma ininterrupta (ignora stopping)
 * para forçar `shutdown.drain_timeout` com processo/container real.
 * Em produção o env fica ausente/0 — no-op.
 * Variável exclusiva de testes; valor inválido explícito rejeita na leitura.
 */
export function shutdownTestHoldMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return optionalNonNegativeInt(
    'SHUTDOWN_TEST_HOLD_MS',
    env.SHUTDOWN_TEST_HOLD_MS,
    0,
  );
}

export async function applyShutdownTestHoldIfConfigured(): Promise<void> {
  const ms = shutdownTestHoldMs();
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
