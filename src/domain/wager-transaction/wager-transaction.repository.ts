import type { WagerTransaction } from './wager-transaction.entity';

export interface WagerTransactionRepository {
  save(transaction: WagerTransaction): Promise<void>;
  findByProviderIdAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;
}

export const WAGER_TRANSACTION_REPOSITORY = Symbol(
  'WAGER_TRANSACTION_REPOSITORY',
);
