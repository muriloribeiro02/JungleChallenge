import {
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type { DataSource } from 'typeorm';
import type {
  LockConflictLabel,
  MessagingConsumerLabel,
  MetricsExposition,
  MetricsPort,
  SqsQueueLabel,
} from '../../application/ports/metrics';
import { safeMetrics } from '../../application/ports/metrics';
import { sqsEnv } from '../messaging/sqs.env';
import { CachedValue } from './cached-value';

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LAG_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 120, 300];

const ALLOWED_STATUSES = new Set([
  'PROCESSED',
  'REJECTED',
  'PENDING_REFERENCE',
]);
const ALLOWED_KINDS = new Set(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']);

export type PrometheusMetricsOptions = {
  dataSource?: DataSource;
  /** TTL cache gauges PG/SQS (ms). Default 10s. */
  gaugeCacheTtlMs?: number;
  /** Coleta métricas default do processo (parcial no Bun). Default false. */
  collectDefaults?: boolean;
  registry?: Registry;
  sqsClient?: SQSClient;
};

export type PrometheusMetrics = MetricsPort & MetricsExposition;

/**
 * Adapter Prometheus (prom-client). Counters/histograms em memória do processo;
 * gauges de outbox/DLQ via PG/SQS com cache.
 */
export function createPrometheusMetrics(
  options: PrometheusMetricsOptions = {},
): PrometheusMetrics {
  const registry = options.registry ?? new Registry();
  const instanceId = process.env.INSTANCE_ID ?? `pid-${process.pid}`;
  registry.setDefaultLabels({ app_instance: instanceId });

  if (options.collectDefaults) {
    collectDefaultMetrics({ register: registry });
  }

  const wagerTotal = new Counter({
    name: 'dwp_wager_transactions_total',
    help: 'Transações de apostas concluídas por kind e status (por processo)',
    labelNames: ['kind', 'status'] as const,
    registers: [registry],
  });

  const wagerReplay = new Counter({
    name: 'dwp_wager_idempotent_replays_total',
    help: 'Replays idempotentes HTTP/inbound (idempotentReplay=true)',
    labelNames: ['kind'] as const,
    registers: [registry],
  });

  const wagerDuration = new Histogram({
    name: 'dwp_wager_transaction_duration_seconds',
    help: 'Duração do processamento da transação (Submit)',
    labelNames: ['kind'] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });

  const msgReceived = new Counter({
    name: 'dwp_messaging_messages_received_total',
    help: 'Mensagens recebidas do bus',
    labelNames: ['consumer'] as const,
    registers: [registry],
  });

  const msgProcessed = new Counter({
    name: 'dwp_messaging_messages_processed_total',
    help: 'Mensagens processadas com efeito (não duplicata)',
    labelNames: ['consumer'] as const,
    registers: [registry],
  });

  const msgDuplicate = new Counter({
    name: 'dwp_messaging_messages_duplicate_total',
    help: 'Duplicatas detectadas pelo Inbox',
    labelNames: ['consumer'] as const,
    registers: [registry],
  });

  const msgFailed = new Counter({
    name: 'dwp_messaging_messages_failed_total',
    help: 'Falhas de processamento (sem ACK / redelivery)',
    labelNames: ['consumer'] as const,
    registers: [registry],
  });

  const msgRetry = new Counter({
    name: 'dwp_messaging_retries_total',
    help: 'Redeliveries observadas (receiveCount > 1)',
    labelNames: ['consumer'] as const,
    registers: [registry],
  });

  const msgDuration = new Histogram({
    name: 'dwp_messaging_processing_duration_seconds',
    help: 'Duração de um pollOnce de consumer',
    labelNames: ['consumer'] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });

  const msgInFlight = new Gauge({
    name: 'dwp_messaging_in_flight',
    help: 'Mensagens em processamento neste processo',
    labelNames: ['consumer'] as const,
    registers: [registry],
  });

  const outboxPublished = new Counter({
    name: 'dwp_outbox_events_published_total',
    help: 'Eventos outbox marcados como publicados',
    registers: [registry],
  });

  const outboxFailed = new Counter({
    name: 'dwp_outbox_events_publish_failures_total',
    help: 'Falhas ao publicar outbox no bus',
    registers: [registry],
  });

  const outboxLag = new Histogram({
    name: 'dwp_outbox_publish_lag_seconds',
    help: 'Lag entre occurred_at do evento e publicação bem-sucedida',
    buckets: LAG_BUCKETS,
    registers: [registry],
  });

  const lockConflicts = new Counter({
    name: 'dwp_concurrency_lock_conflicts_total',
    help: 'Conflitos de concorrência identificados (retry/rejeição)',
    labelNames: ['kind'] as const,
    registers: [registry],
  });

  const reconcileRuns = new Counter({
    name: 'dwp_reconciliation_runs_total',
    help: 'Execuções de reconciliação saldo×ledger',
    registers: [registry],
  });

  const reconcileDivergences = new Counter({
    name: 'dwp_reconciliation_divergences_total',
    help: 'Reconciliações com divergência (consistent=false)',
    registers: [registry],
  });

  const reconcileDuration = new Histogram({
    name: 'dwp_reconciliation_duration_seconds',
    help: 'Duração da reconciliação',
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });

  const pendingProcessed = new Counter({
    name: 'dwp_pending_reference_processed_total',
    help: 'PENDING_REFERENCE resolvidas como PROCESSED pelo worker',
    registers: [registry],
  });

  const pendingRejected = new Counter({
    name: 'dwp_pending_reference_rejected_total',
    help: 'PENDING_REFERENCE rejeitadas pelo worker (inclui TTL)',
    registers: [registry],
  });

  const pendingExpired = new Counter({
    name: 'dwp_pending_reference_expired_total',
    help: 'PENDING_REFERENCE expiradas por TTL (REFERENCE_NOT_FOUND)',
    registers: [registry],
  });

  const pendingDeferred = new Counter({
    name: 'dwp_pending_reference_deferred_total',
    help: 'PENDING_REFERENCE adiadas (backoff) pelo worker',
    registers: [registry],
  });

  const ttlMs = options.gaugeCacheTtlMs ?? 10_000;
  const dataSource = options.dataSource;
  const sqsClient =
    options.sqsClient ??
    new SQSClient({
      region: sqsEnv.region,
      endpoint: sqsEnv.endpoint,
      credentials: {
        accessKeyId: sqsEnv.accessKeyId,
        secretAccessKey: sqsEnv.secretAccessKey,
      },
    });

  const pendingOutboxCache = new CachedValue(
    ttlMs,
    async () => {
      if (!dataSource?.isInitialized) {
        return { count: 0, oldestAgeSeconds: 0 };
      }
      const rows = (await dataSource.query(
        `SELECT
           COUNT(*)::int AS count,
           COALESCE(
             EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))),
             0
           )::float AS oldest_age_seconds
         FROM outbox_message
         WHERE published_at IS NULL`,
      )) as Array<{ count: number; oldest_age_seconds: number }>;
      const row = rows[0] ?? { count: 0, oldest_age_seconds: 0 };
      return {
        count: Number(row.count) || 0,
        oldestAgeSeconds: Number(row.oldest_age_seconds) || 0,
      };
    },
    { count: 0, oldestAgeSeconds: 0 },
  );

  const dlqCache = new CachedValue(
    ttlMs,
    async () => {
      const [events, inbound] = await Promise.all([
        approximateMessages(sqsClient, sqsEnv.dlqUrl),
        approximateMessages(sqsClient, sqsEnv.inboundDlqUrl),
      ]);
      return { events, inbound };
    },
    { events: Number.NaN, inbound: Number.NaN },
  );

  const outboxPendingGauge = new Gauge({
    name: 'dwp_outbox_pending_events',
    help: 'Eventos outbox ainda não publicados (consulta PG agregada, cacheada)',
    registers: [registry],
    async collect() {
      const v = await pendingOutboxCache.get();
      this.set(v.count);
    },
  });

  const outboxOldestGauge = new Gauge({
    name: 'dwp_outbox_oldest_pending_age_seconds',
    help: 'Idade em segundos do outbox pendente mais antigo (PG, cacheado)',
    registers: [registry],
    async collect() {
      const v = await pendingOutboxCache.get();
      this.set(v.oldestAgeSeconds);
    },
  });

  const dlqGauge = new Gauge({
    name: 'dwp_sqs_dlq_approximate_messages',
    help: 'ApproximateNumberOfMessages nas DLQs SQS (aproximado; NaN se indisponível)',
    labelNames: ['queue'] as const,
    registers: [registry],
    async collect() {
      const v = await dlqCache.get();
      if (!Number.isNaN(v.events)) {
        this.set({ queue: 'events_dlq' satisfies SqsQueueLabel }, v.events);
      }
      if (!Number.isNaN(v.inbound)) {
        this.set({ queue: 'inbound_dlq' satisfies SqsQueueLabel }, v.inbound);
      }
    },
  });

  // Referências evitam tree-shake / unused em builds estritos
  void outboxPendingGauge;
  void outboxOldestGauge;
  void dlqGauge;

  const raw: MetricsPort = {
    recordWagerTransaction(input) {
      const kind = ALLOWED_KINDS.has(input.kind) ? input.kind : 'OTHER';
      const status = ALLOWED_STATUSES.has(input.status)
        ? input.status
        : 'OTHER';
      wagerTotal.inc({ kind, status });
      if (input.idempotentReplay) {
        wagerReplay.inc({ kind });
      }
      wagerDuration.observe({ kind }, input.durationSeconds);
    },

    recordMessagingReceived(consumer, count = 1) {
      msgReceived.inc({ consumer }, count);
    },
    recordMessagingProcessed(consumer, count = 1) {
      msgProcessed.inc({ consumer }, count);
    },
    recordMessagingDuplicate(consumer, count = 1) {
      msgDuplicate.inc({ consumer }, count);
    },
    recordMessagingFailed(consumer, count = 1) {
      msgFailed.inc({ consumer }, count);
    },
    recordMessagingRetry(consumer, count = 1) {
      msgRetry.inc({ consumer }, count);
    },
    observeMessagingDuration(consumer, durationSeconds) {
      msgDuration.observe({ consumer }, durationSeconds);
    },
    setMessagingInFlight(consumer, value) {
      msgInFlight.set({ consumer }, value);
    },

    recordOutboxPublished(count = 1) {
      outboxPublished.inc(count);
    },
    recordOutboxPublishFailed(count = 1) {
      outboxFailed.inc(count);
    },
    observeOutboxPublishLag(seconds) {
      outboxLag.observe(seconds);
    },

    recordLockConflict(kind: LockConflictLabel) {
      lockConflicts.inc({ kind });
    },

    recordReconciliation(input) {
      reconcileRuns.inc();
      if (!input.consistent) {
        reconcileDivergences.inc();
      }
      reconcileDuration.observe(input.durationSeconds);
    },

    recordPendingReferenceBatch(input) {
      if (input.processed > 0) pendingProcessed.inc(input.processed);
      if (input.rejected > 0) pendingRejected.inc(input.rejected);
      if (input.expired > 0) pendingExpired.inc(input.expired);
      if (input.deferred > 0) pendingDeferred.inc(input.deferred);
    },
  };

  const port = safeMetrics(raw);

  return {
    ...port,
    contentType: () => registry.contentType,
    collect: () => registry.metrics(),
  };
}

async function approximateMessages(
  client: SQSClient,
  queueUrl: string,
): Promise<number> {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  const raw = result.Attributes?.ApproximateNumberOfMessages;
  if (raw === undefined) {
    return Number.NaN;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Tipagem auxiliar — consumers conhecidos. */
export type { MessagingConsumerLabel };
