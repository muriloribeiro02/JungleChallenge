/**
 * Parsing de inteiros de ambiente.
 * Ausente/vazio → default. Valor presente mas inválido → erro (sem fallback silencioso).
 */

function isBlank(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === '';
}

/**
 * Inteiro positivo (>= 1). Usado por workers, leases, batches, maxReceiveCount, etc.
 */
export function optionalPositiveInt(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (isBlank(raw)) {
    return defaultValue;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `Variável de ambiente inválida: ${name}=${JSON.stringify(raw)} (inteiro >= 1 esperado)`,
    );
  }
  return n;
}

/**
 * Inteiro em intervalo inclusivo [min, max].
 */
export function optionalIntInRange(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (isBlank(raw)) {
    return defaultValue;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(
      `Variável de ambiente inválida: ${name}=${JSON.stringify(raw)} (inteiro entre ${min} e ${max} esperado)`,
    );
  }
  return n;
}

/**
 * Inteiro >= 0 (ex.: VisibilityTimeout SQS permite 0; SHUTDOWN_TEST_HOLD_MS).
 */
export function optionalNonNegativeInt(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (isBlank(raw)) {
    return defaultValue;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(
      `Variável de ambiente inválida: ${name}=${JSON.stringify(raw)} (inteiro >= 0 esperado)`,
    );
  }
  return n;
}
