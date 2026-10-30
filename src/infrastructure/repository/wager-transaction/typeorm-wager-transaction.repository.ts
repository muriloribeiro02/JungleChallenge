import { QueryFailedError, type Repository } from 'typeorm';
import type { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.entity';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  ReferenceAlreadyReversedConflictError,
} from '../../../domain/wager-transaction/wager-transaction.errors';
import type { WagerTransactionRepository } from '../../../domain/wager-transaction/wager-transaction.repository';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WagerTransactionOrmEntity } from './wager-transaction.orm-entity';

const IDEMPOTENCY_UNIQUE_INDEX = 'UQ_wager_transaction_provider_idempotency';
const EXTERNAL_ID_UNIQUE_INDEX = 'UQ_wager_transaction_provider_external_id';
/** Unicidade cross-kind (migration 011); nomes 007 mantidos no matcher por down. */
const PROCESSED_REVERSAL_REF_INDEX =
  'UQ_wager_transaction_processed_reversal_ref';
const LEGACY_REFUND_PROCESSED_REF_INDEX =
  'UQ_wager_transaction_refund_processed_ref';
const LEGACY_ROLLBACK_PROCESSED_REF_INDEX =
  'UQ_wager_transaction_rollback_processed_ref';

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
      if (
        uniqueIndex === PROCESSED_REVERSAL_REF_INDEX ||
        uniqueIndex === LEGACY_REFUND_PROCESSED_REF_INDEX ||
        uniqueIndex === LEGACY_ROLLBACK_PROCESSED_REF_INDEX
      ) {
        throw new ReferenceAlreadyReversedConflictError();
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

  async findByProviderIdAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.transactions.findOne({
      where: { providerId, externalTransactionId },
    });
    if (!row) {
      return null;
    }
    return WagerTransactionMapper.toDomain(row);
  }

  async findProcessedReversalByProviderAndExternalReference(
    providerId: string,
    externalReference: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.transactions
      .createQueryBuilder('tx')
      .where('tx.provider_id = :providerId', { providerId })
      .andWhere('tx.external_reference = :externalReference', {
        externalReference,
      })
      .andWhere('tx.status = :status', { status: 'PROCESSED' })
      .andWhere('tx.kind IN (:...kinds)', { kinds: ['REFUND', 'ROLLBACK'] })
      .getOne();
    if (!row) {
      return null;
    }
    return WagerTransactionMapper.toDomain(row);
  }

  async findPendingByProviderAndExternalReference(
    providerId: string,
    externalReference: string,
  ): Promise<WagerTransaction[]> {
    const rows = await this.transactions
      .createQueryBuilder('tx')
      .where('tx.provider_id = :providerId', { providerId })
      .andWhere('tx.external_reference = :externalReference', {
        externalReference,
      })
      .andWhere('tx.status = :status', { status: 'PENDING_REFERENCE' })
      .orderBy('tx.created_at', 'ASC')
      .addOrderBy('tx.id', 'ASC')
      .getMany();

    return rows.map((row) => WagerTransactionMapper.toDomain(row));
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const row = await this.transactions.findOne({ where: { id } });
    if (!row) {
      return null;
    }
    return WagerTransactionMapper.toDomain(row);
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const row = await this.transactions
      .createQueryBuilder('tx')
      .setLock('pessimistic_write')
      .where('tx.id = :id', { id })
      .getOne();

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
  const known = [
    IDEMPOTENCY_UNIQUE_INDEX,
    EXTERNAL_ID_UNIQUE_INDEX,
    PROCESSED_REVERSAL_REF_INDEX,
    LEGACY_REFUND_PROCESSED_REF_INDEX,
    LEGACY_ROLLBACK_PROCESSED_REF_INDEX,
  ];
  if (named && known.includes(named)) {
    return named;
  }

  const haystack = [
    candidate.driverError?.detail,
    candidate.driverError?.message,
    named,
  ]
    .filter(Boolean)
    .join(' ');

  for (const index of known) {
    if (haystack.includes(index)) {
      return index;
    }
  }

  return null;
}
