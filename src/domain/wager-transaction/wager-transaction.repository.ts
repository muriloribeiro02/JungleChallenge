import type { WagerTransaction } from './wager-transaction.entity';

export interface WagerTransactionRepository {
  save(transaction: WagerTransaction): Promise<void>;
  findByProviderIdAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;
  findByProviderIdAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findProcessedReversalByProviderAndExternalReference(
    kind: 'REFUND' | 'ROLLBACK',
    providerId: string,
    externalReference: string,
  ): Promise<WagerTransaction | null>;
  /**
   * Pendências do mesmo provider + external_reference.
   * Ordenação determinística: created_at ASC, id ASC.
   */
  findPendingByProviderAndExternalReference(
    providerId: string,
    externalReference: string,
  ): Promise<WagerTransaction[]>;
  findById(id: string): Promise<WagerTransaction | null>;
  /** SELECT FOR UPDATE da linha wager_transaction. */
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol(
  'WAGER_TRANSACTION_REPOSITORY',
);
