/**
 * Sanitiza mensagens de erro operacionais para logs / last_error.
 * Não deve expor credenciais, tokens ou payloads financeiros.
 */
export function sanitizeOperationalError(raw: unknown, maxLength = 500): string {
  let message = raw instanceof Error ? raw.message : String(raw);

  message = message.replace(
    /(password|passwd|pwd|secret|token|api[_-]?key|authorization|bearer|credential)\s*[=:]\s*\S+/gi,
    '$1=[REDACTED]',
  );
  message = message.replace(
    /(?:postgres(?:ql)?|mysql|mongodb|amqp|redis):\/\/[^\s'"]+/gi,
    '[REDACTED_URI]',
  );
  message = message.replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]');
  message = message.replace(
    /(?:x-amz-security-token|aws_secret_access_key)\s*[=:]\s*\S+/gi,
    '[REDACTED]',
  );
  message = message.replace(
    /"(?:amount|balance|observedBalance|balanceBefore|balanceAfter)"\s*:\s*"?-?\d+(?:\.\d+)?"?/gi,
    '"[MONEY_FIELD]":"[REDACTED_MONEY]"',
  );

  if (message.length > maxLength) {
    return `${message.slice(0, maxLength)}…`;
  }
  return message;
}
