import 'dotenv/config';

/**
 * Configuração SQS local (LocalStack).
 * Decisões de implementação (contrato não fixa valores):
 * - visibilityTimeoutSeconds: 30
 * - maxReceiveCount: 5
 * - publisherBatchSize: 10
 * - claimLeaseSeconds: 60
 * - receiveWaitSeconds: 1 (testes) / 10 (prod local)
 */
export const sqsEnv = {
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  mainQueueUrl:
    process.env.SQS_MAIN_QUEUE_URL ??
    'http://localhost:4566/000000000000/jungle-wager-events',
  dlqUrl:
    process.env.SQS_DLQ_URL ??
    'http://localhost:4566/000000000000/jungle-wager-events-dlq',
  /** Contrato §10: wager-transactions.fifo (+ DLQ). */
  inboundQueueUrl:
    process.env.SQS_INBOUND_QUEUE_URL ??
    'http://localhost:4566/000000000000/jungle-wager-transactions.fifo',
  inboundDlqUrl:
    process.env.SQS_INBOUND_DLQ_URL ??
    'http://localhost:4566/000000000000/jungle-wager-transactions-dlq.fifo',
  visibilityTimeoutSeconds: Number(
    process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 30,
  ),
  maxReceiveCount: Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5),
  publisherBatchSize: Number(process.env.OUTBOX_PUBLISHER_BATCH_SIZE ?? 10),
  claimLeaseSeconds: Number(process.env.OUTBOX_CLAIM_LEASE_SECONDS ?? 60),
  receiveWaitSeconds: Number(process.env.SQS_RECEIVE_WAIT_SECONDS ?? 1),
  receiveMaxMessages: Number(process.env.SQS_RECEIVE_MAX_MESSAGES ?? 10),
};
