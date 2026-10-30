/**
 * Limite alinhado a PostgreSQL NUMERIC(19,2):
 * 19 dígitos no total, 2 fracionários → até 17 dígitos inteiros.
 *
 * Compartilhado entre Domain (`Money`) e API (`MoneyDto`) para uma única
 * fonte de verdade — sem acoplar HTTP ao VO de domínio.
 */
export const MONEY_MAX_ABS_AMOUNT = '99999999999999999.99';

const MAX_ABS_CENTS = amountToAbsCents(MONEY_MAX_ABS_AMOUNT);

/**
 * Verifica se `amount` (decimal string simples) cabe em NUMERIC(19,2).
 * Não valida formato/escala — o chamador (DTO Matches / Money.parseAmount)
 * já deve ter rejeitado entradas inválidas.
 */
export function isMoneyAmountWithinMaxAbs(amount: string): boolean {
  try {
    return amountToAbsCents(amount) <= MAX_ABS_CENTS;
  } catch {
    return false;
  }
}

function amountToAbsCents(amount: string): bigint {
  const trimmed = amount.trim();
  const unsigned = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed;
  const [rawInt, rawFrac = ''] = unsigned.split('.');
  if (rawInt === undefined || rawInt === '') {
    throw new Error('amount inválido');
  }
  const frac = `${rawFrac}00`.slice(0, 2);
  return BigInt(rawInt) * 100n + BigInt(frac);
}
