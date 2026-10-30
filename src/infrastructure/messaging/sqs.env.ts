import 'dotenv/config';
import {
  optionalIntInRange,
  optionalPositiveInt,
} from '../../shared/parse-env-int';

/**
 * Configuração SQS local (LocalStack).
 * Defaults do código (Compose pode sobrescrever via env nos `app-*` / LocalStack):
 * - visibilityTimeoutSeconds: 30 (AWS: 0–43200)
 * - maxReceiveCount: 5
 * - publisherBatchSize: 10
 * - claimLeaseSeconds: 60
 * - receiveWaitSeconds: 1 (AWS long poll: 0–20)
 * - receiveMaxMessages: 10 (AWS ReceiveMessage: 1–10)
 */
export type SqsEnv = {
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  mainQueueUrl: string;
  dlqUrl: string;
  inboundQueueUrl: string;
  inboundDlqUrl: string;
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
  publisherBatchSize: number;
  claimLeaseSeconds: number;
  receiveWaitSeconds: number;
  receiveMaxMessages: number;
};

export function loadSqsEnv(env: NodeJS.ProcessEnv = process.env): SqsEnv {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    mainQueueUrl:
      env.SQS_MAIN_QUEUE_URL ??
      'http://localhost:4566/000000000000/jungle-wager-events',
    dlqUrl:
      env.SQS_DLQ_URL ??
      'http://localhost:4566/000000000000/jungle-wager-events-dlq',
    inboundQueueUrl:
      env.SQS_INBOUND_QUEUE_URL ??
      'http://localhost:4566/000000000000/jungle-wager-transactions.fifo',
    inboundDlqUrl:
      env.SQS_INBOUND_DLQ_URL ??
      'http://localhost:4566/000000000000/jungle-wager-transactions-dlq.fifo',
    visibilityTimeoutSeconds: optionalIntInRange(
      'SQS_VISIBILITY_TIMEOUT_SECONDS',
      env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      30,
      0,
      43_200,
    ),
    maxReceiveCount: optionalPositiveInt(
      'SQS_MAX_RECEIVE_COUNT',
      env.SQS_MAX_RECEIVE_COUNT,
      5,
    ),
    publisherBatchSize: optionalPositiveInt(
      'OUTBOX_PUBLISHER_BATCH_SIZE',
      env.OUTBOX_PUBLISHER_BATCH_SIZE,
      10,
    ),
    claimLeaseSeconds: optionalPositiveInt(
      'OUTBOX_CLAIM_LEASE_SECONDS',
      env.OUTBOX_CLAIM_LEASE_SECONDS,
      60,
    ),
    receiveWaitSeconds: optionalIntInRange(
      'SQS_RECEIVE_WAIT_SECONDS',
      env.SQS_RECEIVE_WAIT_SECONDS,
      1,
      0,
      20,
    ),
    receiveMaxMessages: optionalIntInRange(
      'SQS_RECEIVE_MAX_MESSAGES',
      env.SQS_RECEIVE_MAX_MESSAGES,
      10,
      1,
      10,
    ),
  };
}

/** Snapshot carregado na importação do módulo (falha cedo se env inválido). */
export const sqsEnv: SqsEnv = loadSqsEnv();
