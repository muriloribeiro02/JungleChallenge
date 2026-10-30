export type MessagingLogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

/**
 * Porta de logging estruturado para publisher/consumer.
 * Implementação concreta vive em infrastructure/logging.
 */
export interface MessagingLogger {
  info(event: string, fields?: MessagingLogFields): void;
  warn(event: string, fields?: MessagingLogFields): void;
  error(event: string, fields?: MessagingLogFields): void;
}

export const MESSAGING_LOGGER = Symbol('MESSAGING_LOGGER');
