/**
 * Porta de mensageria. Implementação (ex.: SQS) fica na infrastructure.
 */
export type BusMessage = {
  /** Identidade estável do evento (eventId). */
  id: string;
  body: string;
  attributes?: Record<string, string>;
};

export type ReceivedBusMessage = {
  id: string;
  body: string;
  receiptHandle: string;
  transportMessageId: string;
  receiveCount: number;
  attributes?: Record<string, string>;
};

export interface MessageBus {
  publish(message: BusMessage): Promise<void>;
  receive(
    maxMessages: number,
    waitTimeSeconds: number,
  ): Promise<ReceivedBusMessage[]>;
  ack(receiptHandle: string): Promise<void>;
  /** Opcional: estender visibility (não usado se DLQ cobrir retries). */
  changeVisibility?(receiptHandle: string, seconds: number): Promise<void>;
}

export const MESSAGE_BUS = Symbol('MESSAGE_BUS');
