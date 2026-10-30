import type { MessagingLogger } from '../../ports/messaging-logger';
import type { UnitOfWork } from '../../ports/unit-of-work';
import {
  FAILURE_CODE_REFERENCE_NOT_FOUND,
  WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_STATUS_REJECTED,
} from '../../../domain/wager-transaction/wager-transaction.entity';
import type { ReprocessPendingReferencesUseCase } from './reprocess-pending-references.use-case';

export type ProcessPendingReferencesOptions = {
  batchSize: number;
  leaseSeconds: number;
};

export type ProcessPendingReferencesBatchResult = {
  claimed: number;
  processed: number;
  rejected: number;
  expired: number;
  deferred: number;
  skipped: number;
};

/**
 * Worker C2: claim SKIP LOCKED de PENDING_REFERENCE elegíveis e reprocessa.
 * TTL / backoff / rejeição REFERENCE_NOT_FOUND ficam em
 * ReprocessPendingReferencesUseCase (mesma UoW rejeição + outbox).
 */
export class ProcessPendingReferencesUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly reprocess: ReprocessPendingReferencesUseCase,
    private readonly logger: MessagingLogger,
    private readonly options: ProcessPendingReferencesOptions,
  ) {}

  async processBatch(): Promise<ProcessPendingReferencesBatchResult> {
    const claimed = await this.unitOfWork.run((repos) =>
      repos.wagerTransactions.claimDuePendingReferences(
        this.options.batchSize,
        this.options.leaseSeconds,
      ),
    );

    let processed = 0;
    let rejected = 0;
    let expired = 0;
    let deferred = 0;
    let skipped = 0;

    for (const item of claimed) {
      const result = await this.reprocess.reprocessOne(item.id);

      if (result.status === WAGER_TRANSACTION_STATUS_PROCESSED) {
        processed += 1;
      } else if (result.status === WAGER_TRANSACTION_STATUS_REJECTED) {
        rejected += 1;
        if (result.failureCode === FAILURE_CODE_REFERENCE_NOT_FOUND) {
          expired += 1;
        }
      } else if (result.status === WAGER_TRANSACTION_STATUS_PENDING_REFERENCE) {
        deferred += 1;
      } else {
        skipped += 1;
      }

      this.logger.info('pending_reference.processed', {
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
        kind: result.kind,
      });
    }

    return {
      claimed: claimed.length,
      processed,
      rejected,
      expired,
      deferred,
      skipped,
    };
  }
}
