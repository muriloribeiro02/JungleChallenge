import { Money, type MoneyProps } from '../money/money';
import { InvalidWagerTransactionError } from './wager-transaction.errors';

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
    public readonly createdAt: Date,
    public readonly updatedAt: Date,
  ) {}

  get kind(): WagerTransactionKind {
    return this.type;
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
      now,
      now,
    );
  }

  static betProcessed(props: ExternalBetProps): WagerTransaction {
    WagerTransaction.assertExternalBetProps(props);
    WagerTransaction.assertPositiveMoney(props.amount, 'BET');

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
      now,
      now,
    );
  }

  static betRejectedInsufficientFunds(
    props: ExternalBetProps,
  ): WagerTransaction {
    WagerTransaction.assertExternalBetProps(props);
    WagerTransaction.assertPositiveMoney(props.amount, 'BET');

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
      now,
      now,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.walletId,
      state.playerId,
      state.type,
      state.status,
      Money.from(state.amount),
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.roundId,
      state.gameId,
      state.failureCode,
      WagerTransaction.toDate(state.createdAt ?? new Date()),
      WagerTransaction.toDate(state.updatedAt ?? new Date()),
    );
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
