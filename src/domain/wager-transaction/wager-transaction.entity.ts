import { Money, type MoneyProps } from '../money/money';
import type { OperationResultSnapshot } from './operation-result-snapshot';
import { InvalidWagerTransactionError } from './wager-transaction.errors';

export type { OperationResultSnapshot } from './operation-result-snapshot';

export const WAGER_TRANSACTION_TYPE_OPENING = 'OPENING' as const;
export const WAGER_TRANSACTION_TYPE_BET = 'BET' as const;

export const WAGER_TRANSACTION_STATUS_PROCESSED = 'PROCESSED' as const;
export const WAGER_TRANSACTION_STATUS_REJECTED = 'REJECTED' as const;

export const FAILURE_CODE_INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS' as const;

export type WagerTransactionKind =
  | typeof WAGER_TRANSACTION_TYPE_OPENING
  | typeof WAGER_TRANSACTION_TYPE_BET;

/** @deprecated use WagerTransactionKind — mantido para compatibilidade OPENING */
export type WagerTransactionType = WagerTransactionKind;

export type WagerTransactionStatus =
  | typeof WAGER_TRANSACTION_STATUS_PROCESSED
  | typeof WAGER_TRANSACTION_STATUS_REJECTED;

export type WagerFailureCode = typeof FAILURE_CODE_INSUFFICIENT_FUNDS;

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
  /** Legado: ambos null/ausentes. Snapshot completo: ambos preenchidos. */
  observedBalance?: MoneyProps | null;
  observedWalletVersion?: number | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

/**
 * Transação de apostas/wallet.
 * OPENING interno ou BET externa (PROCESSED / REJECTED).
 * Estados terminais: sem novas transições após criação.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly playerId: string | null,
    public readonly type: WagerTransactionKind,
    public readonly status: WagerTransactionStatus,
    public readonly amount: Money,
    public readonly providerId: string | null,
    public readonly externalTransactionId: string | null,
    public readonly idempotencyKey: string | null,
    public readonly payloadHash: string | null,
    public readonly roundId: string | null,
    public readonly gameId: string | null,
    public readonly failureCode: WagerFailureCode | null,
    private readonly _observedBalance: Money | null,
    private readonly _observedWalletVersion: number | null,
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  get kind(): WagerTransactionKind {
    return this.type;
  }

  get observedBalance(): Money | null {
    return this._observedBalance;
  }

  get observedWalletVersion(): number | null {
    return this._observedWalletVersion;
  }

  get isTerminal(): boolean {
    return (
      this.status === WAGER_TRANSACTION_STATUS_PROCESSED ||
      this.status === WAGER_TRANSACTION_STATUS_REJECTED
    );
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
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      now,
      now,
    );
  }

  static betProcessed(props: ExternalBetProps): WagerTransaction {
    WagerTransaction.assertExternalBetProps(props);
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
      WAGER_TRANSACTION_STATUS_PROCESSED,
      props.amount,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.roundId,
      props.gameId,
      null,
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      now,
      now,
    );
  }

  static betRejectedInsufficientFunds(
    props: ExternalBetProps,
  ): WagerTransaction {
    WagerTransaction.assertExternalBetProps(props);
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
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      now,
      now,
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
      snapshot.observedBalance,
      snapshot.observedWalletVersion,
      WagerTransaction.toDate(state.createdAt ?? new Date()),
      WagerTransaction.toDate(state.updatedAt ?? new Date()),
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

  private static assertExternalBetProps(props: ExternalBetProps): void {
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

  private static assertRequiredId(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidWagerTransactionError(`${field} é obrigatório`);
    }
  }

  private static toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }
}
