import { QueryFailedError, type Repository } from 'typeorm';
import type { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.entity';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
} from '../../../domain/wager-transaction/wager-transaction.errors';
import type { WagerTransactionRepository } from '../../../domain/wager-transaction/wager-transaction.repository';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WagerTransactionOrmEntity } from './wager-transaction.orm-entity';

const IDEMPOTENCY_UNIQUE_INDEX = 'UQ_wager_transaction_provider_idempotency';
const EXTERNAL_ID_UNIQUE_INDEX = 'UQ_wager_transaction_provider_external_id';

export class TypeOrmWagerTransactionRepository
  implements WagerTransactionRepository
{
  constructor(
    private readonly transactions: Repository<WagerTransactionOrmEntity>,
  ) {}

  async save(transaction: WagerTransaction): Promise<void> {
    try {
      await this.transactions.save(
        WagerTransactionMapper.toPersistence(transaction),
      );
    } catch (error) {
      const uniqueIndex = getUniqueViolationIndexName(error);
      if (uniqueIndex === IDEMPOTENCY_UNIQUE_INDEX) {
        throw new IdempotencyKeyConflictError();
      }
      if (uniqueIndex === EXTERNAL_ID_UNIQUE_INDEX) {
        throw new ExternalTransactionIdConflictError();
      }
      throw error;
    }
  }

  async findByProviderIdAndIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.transactions.findOne({
      where: { providerId, idempotencyKey },
    });
    if (!row) {
      return null;
    }
    return WagerTransactionMapper.toDomain(row);
  }
}

function getUniqueViolationIndexName(error: unknown): string | null {
  if (!(error instanceof QueryFailedError) && !(error && typeof error === 'object')) {
    return null;
  }

  const candidate = error as {
    code?: string;
    constraint?: string;
    driverError?: {
      code?: string;
      constraint?: string;
      detail?: string;
      message?: string;
    };
  };

  const code = candidate.driverError?.code ?? candidate.code;
  if (code !== '23505') {
    return null;
  }

  const named =
    candidate.driverError?.constraint ?? candidate.constraint ?? null;
  if (named === IDEMPOTENCY_UNIQUE_INDEX || named === EXTERNAL_ID_UNIQUE_INDEX) {
    return named;
  }

  const haystack = [
    candidate.driverError?.detail,
    candidate.driverError?.message,
    named,
  ]
    .filter(Boolean)
    .join(' ');

  if (haystack.includes(IDEMPOTENCY_UNIQUE_INDEX)) {
    return IDEMPOTENCY_UNIQUE_INDEX;
  }
  if (haystack.includes(EXTERNAL_ID_UNIQUE_INDEX)) {
    return EXTERNAL_ID_UNIQUE_INDEX;
  }

  return null;
}
