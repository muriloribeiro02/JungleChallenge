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
  /**
   * Qualquer REFUND ou ROLLBACK PROCESSED apontando para a mesma referência
   * externa (unicidade financeira cross-kind — ver migration 011).
   */
  findProcessedReversalByProviderAndExternalReference(
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
  /**
   * Reserva pendências elegíveis (due ou TTL expirado) com FOR UPDATE SKIP LOCKED.
   * Define locked_until (lease). Não incrementa pending_attempt_count —
   * a contagem sobe só em defer (recordDeferRetry), comum a Inbox e worker.
   * Expiração (pending_reference_at + 24h) prevalece sobre next_attempt_at futuro.
   */
  claimDuePendingReferences(
    limit: number,
    leaseSeconds: number,
  ): Promise<WagerTransaction[]>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol(
  'WAGER_TRANSACTION_REPOSITORY',
);
