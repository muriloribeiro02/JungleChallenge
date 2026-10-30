import { QueryFailedError, type EntityManager, type Repository } from 'typeorm';
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
    private readonly manager?: EntityManager,
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

  async claimDuePendingReferences(
    limit: number,
    leaseSeconds: number,
  ): Promise<WagerTransaction[]> {
    const em = this.manager ?? this.transactions.manager;
    const result: unknown = await em.query(
      `
        WITH cte AS (
          SELECT id
          FROM wager_transaction
          WHERE status = 'PENDING_REFERENCE'
            AND pending_reference_at IS NOT NULL
            AND (locked_until IS NULL OR locked_until < NOW())
            AND (
              pending_reference_at + INTERVAL '24 hours' <= NOW()
              OR next_attempt_at IS NULL
              OR next_attempt_at <= NOW()
            )
          ORDER BY pending_reference_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE wager_transaction AS t
        SET
          locked_until = NOW() + make_interval(secs => $2),
          updated_at = NOW()
        FROM cte
        WHERE t.id = cte.id
        RETURNING
          t.id,
          t.wallet_id AS "walletId",
          t.player_id AS "playerId",
          t.kind,
          t.status,
          t.amount,
          t.currency,
          t.provider_id AS "providerId",
          t.external_transaction_id AS "externalTransactionId",
          t.idempotency_key AS "idempotencyKey",
          t.payload_hash AS "payloadHash",
          t.round_id AS "roundId",
          t.game_id AS "gameId",
          t.external_reference AS "externalReference",
          t.resolved_internal_reference AS "resolvedInternalReference",
          t.failure_code AS "failureCode",
          t.observed_balance AS "observedBalance",
          t.observed_wallet_version AS "observedWalletVersion",
          t.created_at AS "createdAt",
          t.updated_at AS "updatedAt",
          t.pending_reference_at AS "pendingReferenceAt",
          t.pending_attempt_count AS "pendingAttemptCount",
          t.next_attempt_at AS "nextAttemptAt",
          t.locked_until AS "lockedUntil"
      `,
      [limit, leaseSeconds],
    );

    const rows = unwrapReturningRows(result);
    return rows.map((row) =>
      WagerTransactionMapper.toDomain({
        id: row.id,
        walletId: row.walletId,
        playerId: row.playerId,
        kind: row.kind,
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        providerId: row.providerId,
        externalTransactionId: row.externalTransactionId,
        idempotencyKey: row.idempotencyKey,
        payloadHash: row.payloadHash,
        roundId: row.roundId,
        gameId: row.gameId,
        externalReference: row.externalReference,
        resolvedInternalReference: row.resolvedInternalReference,
        failureCode: row.failureCode,
        observedBalance: row.observedBalance,
        observedWalletVersion: row.observedWalletVersion,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        pendingReferenceAt: row.pendingReferenceAt,
        pendingAttemptCount: Number(row.pendingAttemptCount),
        nextAttemptAt: row.nextAttemptAt,
        lockedUntil: row.lockedUntil,
      } as WagerTransactionOrmEntity),
    );
  }
}

function unwrapReturningRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    if (result.length === 2 && Array.isArray(result[0])) {
      return result[0] as Array<Record<string, unknown>>;
    }
    return result as Array<Record<string, unknown>>;
  }
  return [];
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
