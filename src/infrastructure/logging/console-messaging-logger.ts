import type {
  MessagingLogFields,
  MessagingLogger,
} from '../../application/ports/messaging-logger';

/**
 * Logger estruturado: JSON em uma linha no stdout (sem PII).
 */
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
