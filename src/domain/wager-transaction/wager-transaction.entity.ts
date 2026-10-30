import { Money, type MoneyProps } from '../money/money';
import type { OperationResultSnapshot } from './operation-result-snapshot';
import {
  FAILURE_CODE_INSUFFICIENT_FUNDS,
  type WagerFailureCode,
} from './failure-codes';
import { InvalidWagerTransactionError } from './wager-transaction.errors';

export type { OperationResultSnapshot } from './operation-result-snapshot';
export type { WagerFailureCode } from './failure-codes';
export {
  FAILURE_CODE_INSUFFICIENT_FUNDS,
  FAILURE_CODE_INVALID_REFERENCE_TYPE,
  FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
  FAILURE_CODE_REFERENCE_AMOUNT_MISMATCH,
  FAILURE_CODE_REFERENCE_NOT_FOUND,
  FAILURE_CODE_REFERENCE_NOT_PROCESSED,
  FAILURE_CODE_REFERENCE_SCOPE_MISMATCH,
  FAILURE_CODE_REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE,
} from './failure-codes';

export const WAGER_TRANSACTION_TYPE_OPENING = 'OPENING' as const;
export const WAGER_TRANSACTION_TYPE_BET = 'BET' as const;
export const WAGER_TRANSACTION_TYPE_WIN = 'WIN' as const;
export const WAGER_TRANSACTION_TYPE_LOSS = 'LOSS' as const;
export const WAGER_TRANSACTION_TYPE_REFUND = 'REFUND' as const;
export const WAGER_TRANSACTION_TYPE_ROLLBACK = 'ROLLBACK' as const;

export const WAGER_TRANSACTION_STATUS_PENDING_REFERENCE =
  'PENDING_REFERENCE' as const;
export const WAGER_TRANSACTION_STATUS_PROCESSED = 'PROCESSED' as const;
export const WAGER_TRANSACTION_STATUS_REJECTED = 'REJECTED' as const;

export type WagerTransactionKind =
  | typeof WAGER_TRANSACTION_TYPE_OPENING
  | typeof WAGER_TRANSACTION_TYPE_BET
  | typeof WAGER_TRANSACTION_TYPE_WIN
  | typeof WAGER_TRANSACTION_TYPE_LOSS
  | typeof WAGER_TRANSACTION_TYPE_REFUND
  | typeof WAGER_TRANSACTION_TYPE_ROLLBACK;

/** @deprecated use WagerTransactionKind */
export type WagerTransactionType = WagerTransactionKind;

export type WagerTransactionStatus =
  | typeof WAGER_TRANSACTION_STATUS_PENDING_REFERENCE
  | typeof WAGER_TRANSACTION_STATUS_PROCESSED
  | typeof WAGER_TRANSACTION_STATUS_REJECTED;

export type OpeningProcessedProps = {
  id: string;
  walletId: string;
  amount: Money;
  snapshot: OperationResultSnapshot;
};

export type ExternalBetProps = {
  id: string;
  walletId: string;
  playerId: string;
  amount: Money;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  roundId: string;
  gameId: string;
  snapshot: OperationResultSnapshot;
};

export type ExternalWagerProps = ExternalBetProps;

export type ReversalPendingProps = Omit<ExternalBetProps, 'snapshot'> & {
  externalReference: string;
};

export type ReversalProcessedProps = ExternalBetProps & {
  externalReference: string;
  resolvedInternalReference: string;
};

export type ReversalRejectedProps = ExternalBetProps & {
  externalReference: string;
  resolvedInternalReference: string | null;
  failureCode: WagerFailureCode;
};

export type WagerTransactionState = {
  id: string;
  walletId: string;
  playerId: string | null;
  type: WagerTransactionKind;
  status: WagerTransactionStatus;
  amount: MoneyProps;
  providerId: string | null;
  externalTransactionId: string | null;
  idempotencyKey: string | null;
  payloadHash: string | null;
  roundId: string | null;
  gameId: string | null;
  failureCode: WagerFailureCode | null;
  externalReference?: string | null;
  resolvedInternalReference?: string | null;
  observedBalance?: MoneyProps | null;
  observedWalletVersion?: number | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

/**
 * Transação de apostas/wallet.
 * PENDING_REFERENCE não é terminal e não carrega snapshot.
 * PROCESSED / REJECTED são terminais.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly playerId: string | null,
    private _type: WagerTransactionKind,
    private _status: WagerTransactionStatus,
    public readonly amount: Money,
    public readonly providerId: string | null,
    public readonly externalTransactionId: string | null,
    public readonly idempotencyKey: string | null,
    public readonly payloadHash: string | null,
    public readonly roundId: string | null,
    public readonly gameId: string | null,
    private _failureCode: WagerFailureCode | null,
    public readonly externalReference: string | null,
    private _resolvedInternalReference: string | null,
    private _observedBalance: Money | null,
    private _observedWalletVersion: number | null,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  get type(): WagerTransactionKind {
    return this._type;
  }

  get kind(): WagerTransactionKind {
    return this._type;
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get failureCode(): WagerFailureCode | null {
    return this._failureCode;
  }

  get resolvedInternalReference(): string | null {
    return this._resolvedInternalReference;
  }

  /** Alias de domínio para o id interno resolvido da referência. */
  get referenceTransactionId(): string | null {
    return this._resolvedInternalReference;
  }

  get observedBalance(): Money | null {
    return this._observedBalance;
  }

  get observedWalletVersion(): number | null {
    return this._observedWalletVersion;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get isTerminal(): boolean {
    return (
      this._status === WAGER_TRANSACTION_STATUS_PROCESSED ||
      this._status === WAGER_TRANSACTION_STATUS_REJECTED
    );
  }

  /**
   * Direção do ledger para ROLLBACK a partir do kind da referência.
   * REFUND de BET é sempre CREDIT (não usa este método).
   */
  static ledgerDirectionForRollback(
    referenceKind: WagerTransactionKind,
  ): 'CREDIT' | 'DEBIT' {
    if (referenceKind === WAGER_TRANSACTION_TYPE_BET) {
      return 'CREDIT';
    }
    if (
      referenceKind === WAGER_TRANSACTION_TYPE_WIN ||
      referenceKind === WAGER_TRANSACTION_TYPE_REFUND
    ) {
      return 'DEBIT';
    }
    throw new InvalidWagerTransactionError(
      `kind de referência não suportado para ROLLBACK: ${referenceKind}`,
    );
  }

  /**
   * Transição PENDING_REFERENCE → PROCESSED (reprocessamento).
   */
  markProcessed(
    resolvedInternalReference: string,
    snapshot: OperationResultSnapshot,
    at: Date = new Date(),
  ): void {
    if (this._status !== WAGER_TRANSACTION_STATUS_PENDING_REFERENCE) {
      throw new InvalidWagerTransactionError(
        'somente PENDING_REFERENCE pode ser marcada como PROCESSED',
      );
    }
    WagerTransaction.assertRequiredId(
      resolvedInternalReference,
      'resolvedInternalReference',
    );
    const snap = WagerTransaction.assertSnapshot(snapshot, this.amount);
    this._resolvedInternalReference = resolvedInternalReference;
    this._status = WAGER_TRANSACTION_STATUS_PROCESSED;
    this._failureCode = null;
    this._observedBalance = snap.observedBalance;
    this._observedWalletVersion = snap.observedWalletVersion;
    this._updatedAt = at;
  }

  /**
   * Transição PENDING_REFERENCE → REJECTED (reprocessamento com regra de negócio).
   * Não usar para falhas técnicas transitórias.
   */
  markRejected(
    failureCode: WagerFailureCode,
    snapshot: OperationResultSnapshot,
    resolvedInternalReference: string | null,
    at: Date = new Date(),
  ): void {
    if (this._status !== WAGER_TRANSACTION_STATUS_PENDING_REFERENCE) {
      throw new InvalidWagerTransactionError(
        'somente PENDING_REFERENCE pode ser marcada como REJECTED',
      );
    }
    if (!failureCode) {
      throw new InvalidWagerTransactionError('failureCode é obrigatório');
    }
    const snap = WagerTransaction.assertSnapshot(snapshot, this.amount);
    this._resolvedInternalReference = resolvedInternalReference;
    this._status = WAGER_TRANSACTION_STATUS_REJECTED;
    this._failureCode = failureCode;
    this._observedBalance = snap.observedBalance;
    this._observedWalletVersion = snap.observedWalletVersion;
    this._updatedAt = at;
  }

  static openingProcessed(props: OpeningProcessedProps): WagerTransaction {
    WagerTransaction.assertRequiredId(props.id, 'id');
    WagerTransaction.assertRequiredId(props.walletId, 'walletId');
    WagerTransaction.assertPositiveMoney(props.amount, 'OPENING');
    const snapshot = WagerTransaction.assertSnapshot(
      props.snapshot,
      props.amount,
    );
    const now = new Date();
    return new WagerTransaction(
      props.id,
      props.walletId,
      null,
      WAGER_TRANSACTION_TYPE_OPENING,
      WAGER_TRANSACTION_STATUS_PROCESSED,
      props.amount,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      now,
      now,
    );
  }

  static betProcessed(props: ExternalBetProps): WagerTransaction {
    return WagerTransaction.createExternalProcessed(
      props,
      WAGER_TRANSACTION_TYPE_BET,
      () => WagerTransaction.assertPositiveMoney(props.amount, 'BET'),
    );
  }

  static betRejectedInsufficientFunds(
    props: ExternalBetProps,
  ): WagerTransaction {
    WagerTransaction.assertExternalMeta(props);
    WagerTransaction.assertPositiveMoney(props.amount, 'BET');
    const snapshot = WagerTransaction.assertSnapshot(
      props.snapshot,
      props.amount,
    );
    const now = new Date();
    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      WAGER_TRANSACTION_TYPE_BET,
      WAGER_TRANSACTION_STATUS_REJECTED,
      props.amount,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      FAILURE_CODE_INSUFFICIENT_FUNDS,
      null,
      null,
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      now,
      now,
    );
  }

  static winProcessed(props: ExternalWagerProps): WagerTransaction {
    return WagerTransaction.createExternalProcessed(
      props,
      WAGER_TRANSACTION_TYPE_WIN,
      () => WagerTransaction.assertPositiveMoney(props.amount, 'WIN'),
    );
  }

  static lossProcessed(props: ExternalWagerProps): WagerTransaction {
    return WagerTransaction.createExternalProcessed(
      props,
      WAGER_TRANSACTION_TYPE_LOSS,
      () => WagerTransaction.assertZeroMoney(props.amount, 'LOSS'),
    );
  }

  static refundPendingReference(
    props: ReversalPendingProps,
  ): WagerTransaction {
    WagerTransaction.assertExternalMeta(props);
    WagerTransaction.assertPositiveMoney(props.amount, 'REFUND');
    WagerTransaction.assertRequiredId(
      props.externalReference,
      'externalReference',
    );
    const now = new Date();
    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      WAGER_TRANSACTION_TYPE_REFUND,
      WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
      props.amount,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      null,
      props.externalReference,
      null,
      null,
      null,
      now,
      now,
    );
  }

  static refundProcessed(props: ReversalProcessedProps): WagerTransaction {
    WagerTransaction.assertExternalMeta(props);
    WagerTransaction.assertPositiveMoney(props.amount, 'REFUND');
    WagerTransaction.assertRequiredId(
      props.externalReference,
      'externalReference',
    );
    WagerTransaction.assertRequiredId(
      props.resolvedInternalReference,
      'resolvedInternalReference',
    );
    const snapshot = WagerTransaction.assertSnapshot(
      props.snapshot,
      props.amount,
    );
    const now = new Date();
    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      WAGER_TRANSACTION_TYPE_REFUND,
      WAGER_TRANSACTION_STATUS_PROCESSED,
      props.amount,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      null,
      props.externalReference,
      props.resolvedInternalReference,
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      now,
      now,
    );
  }

  static refundRejected(props: ReversalRejectedProps): WagerTransaction {
    return WagerTransaction.createReversalRejected(
      props,
      WAGER_TRANSACTION_TYPE_REFUND,
    );
  }

  static rollbackPendingReference(
    props: ReversalPendingProps,
  ): WagerTransaction {
    WagerTransaction.assertExternalMeta(props);
    WagerTransaction.assertPositiveMoney(props.amount, 'ROLLBACK');
    WagerTransaction.assertRequiredId(
      props.externalReference,
      'externalReference',
    );
    const now = new Date();
    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      WAGER_TRANSACTION_TYPE_ROLLBACK,
      WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
      props.amount,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      null,
      props.externalReference,
      null,
      null,
      null,
      now,
      now,
    );
  }

  static rollbackProcessed(props: ReversalProcessedProps): WagerTransaction {
    WagerTransaction.assertExternalMeta(props);
    WagerTransaction.assertPositiveMoney(props.amount, 'ROLLBACK');
    WagerTransaction.assertRequiredId(
      props.externalReference,
      'externalReference',
    );
    WagerTransaction.assertRequiredId(
      props.resolvedInternalReference,
      'resolvedInternalReference',
    );
    const snapshot = WagerTransaction.assertSnapshot(
      props.snapshot,
      props.amount,
    );
    const now = new Date();
    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      WAGER_TRANSACTION_TYPE_ROLLBACK,
      WAGER_TRANSACTION_STATUS_PROCESSED,
      props.amount,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      null,
      props.externalReference,
      props.resolvedInternalReference,
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      now,
      now,
    );
  }

  static rollbackRejected(props: ReversalRejectedProps): WagerTransaction {
    return WagerTransaction.createReversalRejected(
      props,
      WAGER_TRANSACTION_TYPE_ROLLBACK,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    const amount = Money.from(state.amount);
    const snapshot = WagerTransaction.rehydrateSnapshot(state, amount);

    return new WagerTransaction(
      state.id,
      state.walletId,
      state.playerId,
      state.type,
      state.status,
      amount,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.roundId,
      state.gameId,
      state.failureCode,
      state.externalReference ?? null,
      state.resolvedInternalReference ?? null,
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      WagerTransaction.toDate(state.createdAt ?? new Date()),
      WagerTransaction.toDate(state.updatedAt ?? new Date()),
    );
  }

  private static createExternalProcessed(
    props: ExternalBetProps,
    kind: WagerTransactionKind,
    assertAmount: () => void,
  ): WagerTransaction {
    WagerTransaction.assertExternalMeta(props);
    assertAmount();
    const snapshot = WagerTransaction.assertSnapshot(
      props.snapshot,
      props.amount,
    );
    const now = new Date();
    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      kind,
      WAGER_TRANSACTION_STATUS_PROCESSED,
      props.amount,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      null,
      null,
      null,
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      now,
      now,
    );
  }

  private static createReversalRejected(
    props: ReversalRejectedProps,
    kind: typeof WAGER_TRANSACTION_TYPE_REFUND | typeof WAGER_TRANSACTION_TYPE_ROLLBACK,
  ): WagerTransaction {
    WagerTransaction.assertExternalMeta(props);
    WagerTransaction.assertPositiveMoney(
      props.amount,
      kind === WAGER_TRANSACTION_TYPE_REFUND ? 'REFUND' : 'ROLLBACK',
    );
    WagerTransaction.assertRequiredId(
      props.externalReference,
      'externalReference',
    );
    if (!props.failureCode) {
      throw new InvalidWagerTransactionError('failureCode é obrigatório');
    }
    const snapshot = WagerTransaction.assertSnapshot(
      props.snapshot,
      props.amount,
    );
    const now = new Date();
    return new WagerTransaction(
      props.id,
      props.walletId,
      props.playerId,
      kind,
      WAGER_TRANSACTION_STATUS_REJECTED,
      props.amount,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      props.failureCode,
      props.externalReference,
      props.resolvedInternalReference,
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      now,
      now,
    );
  }

  private static rehydrateSnapshot(
    state: WagerTransactionState,
    transactionAmount: Money,
  ): {
    observedBalance: Money | null;
    observedWalletVersion: number | null;
  } {
    const hasBalance =
      state.observedBalance !== undefined && state.observedBalance !== null;
    const hasVersion =
      state.observedWalletVersion !== undefined &&
      state.observedWalletVersion !== null;

    if (!hasBalance && !hasVersion) {
      return { observedBalance: null, observedWalletVersion: null };
    }

    if (hasBalance !== hasVersion) {
      throw new InvalidWagerTransactionError(
        'snapshot legado inconsistente: observedBalance e observedWalletVersion devem existir juntos',
      );
    }

    return WagerTransaction.assertSnapshot(
      {
        observedBalance: Money.from(state.observedBalance as MoneyProps),
        observedWalletVersion: state.observedWalletVersion as number,
      },
      transactionAmount,
    );
  }

  private static assertSnapshot(
    snapshot: OperationResultSnapshot | null | undefined,
    transactionAmount: Money,
  ): OperationResultSnapshot {
    if (snapshot == null || typeof snapshot !== 'object') {
      throw new InvalidWagerTransactionError(
        'snapshot do resultado é obrigatório para operações terminais',
      );
    }

    if (!(snapshot.observedBalance instanceof Money)) {
      throw new InvalidWagerTransactionError(
        'observedBalance deve ser uma instância de Money',
      );
    }

    if (snapshot.observedBalance.isNegative()) {
      throw new InvalidWagerTransactionError(
        'observedBalance não pode ser negativo',
      );
    }

    if (snapshot.observedBalance.currency !== transactionAmount.currency) {
      throw new InvalidWagerTransactionError(
        'observedBalance.currency deve ser igual à currency da transação',
      );
    }

    if (
      typeof snapshot.observedWalletVersion !== 'number' ||
      !Number.isInteger(snapshot.observedWalletVersion) ||
      snapshot.observedWalletVersion < 1
    ) {
      throw new InvalidWagerTransactionError(
        'observedWalletVersion deve ser um inteiro >= 1',
      );
    }

    return snapshot;
  }

  private static assertExternalMeta(
    props: Omit<ExternalBetProps, 'snapshot'> | ExternalBetProps,
  ): void {
    WagerTransaction.assertRequiredId(props.id, 'id');
    WagerTransaction.assertRequiredId(props.walletId, 'walletId');
    WagerTransaction.assertRequiredId(props.playerId, 'playerId');
    WagerTransaction.assertRequiredId(props.providerId, 'providerId');
    WagerTransaction.assertRequiredId(
      props.externalTransactionId,
      'externalTransactionId',
    );
    WagerTransaction.assertRequiredId(props.idempotencyKey, 'idempotencyKey');
    WagerTransaction.assertRequiredId(props.payloadHash, 'payloadHash');
    WagerTransaction.assertRequiredId(props.roundId, 'roundId');
    WagerTransaction.assertRequiredId(props.gameId, 'gameId');
  }

  private static assertPositiveMoney(amount: Money, kind: string): void {
    if (!(amount instanceof Money)) {
      throw new InvalidWagerTransactionError(
        'amount deve ser uma instância de Money',
      );
    }
    if (!amount.isPositive()) {
      throw new InvalidWagerTransactionError(
        `amount da ${kind} deve ser positivo`,
      );
    }
  }

  private static assertZeroMoney(amount: Money, kind: string): void {
    if (!(amount instanceof Money)) {
      throw new InvalidWagerTransactionError(
        'amount deve ser uma instância de Money',
      );
    }
    if (!amount.isZero()) {
      throw new InvalidWagerTransactionError(
        `amount da ${kind} deve ser zero`,
      );
    }
  }

  private static assertRequiredId(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidWagerTransactionError(`${field} é obrigatório`);
    }
  }

  private static toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }
}
