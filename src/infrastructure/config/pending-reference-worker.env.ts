import { optionalPositiveInt } from '../../shared/parse-env-int';

export type PendingReferenceWorkerEnv = {
  batchSize: number;
  leaseSeconds: number;
};

/**
 * Defaults do código (Compose `app-*` pode usar lease 15 e batch 10).
 * - PENDING_REFERENCE_BATCH_SIZE → 10
 * - PENDING_REFERENCE_LEASE_SECONDS → 30
 */
export function loadPendingReferenceWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): PendingReferenceWorkerEnv {
  return {
    batchSize: optionalPositiveInt(
      'PENDING_REFERENCE_BATCH_SIZE',
      env.PENDING_REFERENCE_BATCH_SIZE,
      10,
    ),
    leaseSeconds: optionalPositiveInt(
      'PENDING_REFERENCE_LEASE_SECONDS',
      env.PENDING_REFERENCE_LEASE_SECONDS,
      30,
    ),
  };
}
