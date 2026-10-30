/**
 * Porta de métricas (application). Sem dependência de Prometheus.
 * Falhas do recorder NÃO devem propagar para a lógica financeira.
 */

export type MessagingConsumerLabel = 'domain_events' | 'wager_inbound';

export type LockConflictLabel = 'idempotency_key' | 'reference_reversed';

export type SqsQueueLabel = 'events' | 'inbound' | 'events_dlq' | 'inbound_dlq';

export type MetricsPort = {
  recordWagerTransaction(input: {
    kind: string;
    status: string;
    idempotentReplay: boolean;
    durationSeconds: number;
  }): void;

  recordMessagingReceived(consumer: MessagingConsumerLabel, count?: number): void;
  recordMessagingProcessed(consumer: MessagingConsumerLabel, count?: number): void;
  recordMessagingDuplicate(consumer: MessagingConsumerLabel, count?: number): void;
  recordMessagingFailed(consumer: MessagingConsumerLabel, count?: number): void;
  /** Redelivery observada (ApproximateReceiveCount > 1). */
  recordMessagingRetry(consumer: MessagingConsumerLabel, count?: number): void;
  observeMessagingDuration(
    consumer: MessagingConsumerLabel,
    durationSeconds: number,
  ): void;
  setMessagingInFlight(consumer: MessagingConsumerLabel, value: number): void;

  recordOutboxPublished(count?: number): void;
  recordOutboxPublishFailed(count?: number): void;
  observeOutboxPublishLag(seconds: number): void;

  recordLockConflict(kind: LockConflictLabel): void;

  recordReconciliation(input: {
    consistent: boolean;
    durationSeconds: number;
  }): void;

  /** Contadores do worker PENDING_REFERENCE (por outcome agregado do batch). */
  recordPendingReferenceBatch(input: {
    processed: number;
    rejected: number;
    expired: number;
    deferred: number;
  }): void;
};

/** Exposition HTTP (infra + API); separado da porta de gravação. */
export type MetricsExposition = {
  contentType(): string;
  collect(): Promise<string>;
};

export const noopMetrics: MetricsPort = {
  recordWagerTransaction() {},
  recordMessagingReceived() {},
  recordMessagingProcessed() {},
  recordMessagingDuplicate() {},
  recordMessagingFailed() {},
  recordMessagingRetry() {},
  observeMessagingDuration() {},
  setMessagingInFlight() {},
  recordOutboxPublished() {},
  recordOutboxPublishFailed() {},
  observeOutboxPublishLag() {},
  recordLockConflict() {},
  recordReconciliation() {},
  recordPendingReferenceBatch() {},
};

/** Envolve o port para que erros de instrumentação nunca quebrem o negócio. */
export function safeMetrics(inner: MetricsPort): MetricsPort {
  const wrap =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A): void => {
      try {
        fn(...args);
      } catch {
        // métricas nunca interferem
      }
    };

  return {
    recordWagerTransaction: wrap(inner.recordWagerTransaction.bind(inner)),
    recordMessagingReceived: wrap(inner.recordMessagingReceived.bind(inner)),
    recordMessagingProcessed: wrap(inner.recordMessagingProcessed.bind(inner)),
    recordMessagingDuplicate: wrap(inner.recordMessagingDuplicate.bind(inner)),
    recordMessagingFailed: wrap(inner.recordMessagingFailed.bind(inner)),
    recordMessagingRetry: wrap(inner.recordMessagingRetry.bind(inner)),
    observeMessagingDuration: wrap(inner.observeMessagingDuration.bind(inner)),
    setMessagingInFlight: wrap(inner.setMessagingInFlight.bind(inner)),
    recordOutboxPublished: wrap(inner.recordOutboxPublished.bind(inner)),
    recordOutboxPublishFailed: wrap(inner.recordOutboxPublishFailed.bind(inner)),
    observeOutboxPublishLag: wrap(inner.observeOutboxPublishLag.bind(inner)),
    recordLockConflict: wrap(inner.recordLockConflict.bind(inner)),
    recordReconciliation: wrap(inner.recordReconciliation.bind(inner)),
    recordPendingReferenceBatch: wrap(
      inner.recordPendingReferenceBatch.bind(inner),
    ),
  };
}

export function elapsedSecondsSince(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e9;
}
