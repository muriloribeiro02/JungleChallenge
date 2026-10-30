export type MessagingLogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * Logger estruturado mínimo para publisher/consumer.
 * Decisão: JSON em uma linha no stdout (sem PII).
 */
export interface MessagingLogger {
  info(event: string, fields?: MessagingLogFields): void;
  warn(event: string, fields?: MessagingLogFields): void;
  error(event: string, fields?: MessagingLogFields): void;
}

export class ConsoleMessagingLogger implements MessagingLogger {
  info(event: string, fields: MessagingLogFields = {}): void {
    console.log(JSON.stringify({ level: 'info', event, ...fields }));
  }

  warn(event: string, fields: MessagingLogFields = {}): void {
    console.warn(JSON.stringify({ level: 'warn', event, ...fields }));
  }

  error(event: string, fields: MessagingLogFields = {}): void {
    console.error(JSON.stringify({ level: 'error', event, ...fields }));
  }
}
