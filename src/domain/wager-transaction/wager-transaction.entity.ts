import { Money, type MoneyProps } from '../money/money';
import { InvalidWagerTransactionError } from './wager-transaction.errors';

export const WAGER_TRANSACTION_TYPE_OPENING = 'OPENING' as const;
export const WAGER_TRANSACTION_STATUS_PROCESSED = 'PROCESSED' as const;

export type WagerTransactionType = typeof WAGER_TRANSACTION_TYPE_OPENING;
export type WagerTransactionStatus = typeof WAGER_TRANSACTION_STATUS_PROCESSED;

export type OpeningProcessedProps = {
  id: string;
  walletId: string;
  amount: Money;
};

export type WagerTransactionState = {
  id: string;
  walletId: string;
  type: WagerTransactionType;
  status: WagerTransactionStatus;
  amount: MoneyProps;
};

/**
 * Transação interna de apostas/wallet.
 * Nesta etapa: apenas abertura (OPENING) já processada (PROCESSED).
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly type: WagerTransactionType,
    public readonly status: WagerTransactionStatus,
    public readonly amount: Money,
  ) {}

  /**
   * Abertura de carteira com crédito inicial positivo.
   * type=OPENING, status=PROCESSED; amount deve ser Money positivo.
   */
  static openingProcessed(props: OpeningProcessedProps): WagerTransaction {
    WagerTransaction.assertRequiredId(props.id, 'id');
    WagerTransaction.assertRequiredId(props.walletId, 'walletId');

    if (!(props.amount instanceof Money)) {
      throw new InvalidWagerTransactionError(
        'amount deve ser uma instância de Money',
      );
    }

    if (!props.amount.isPositive()) {
      throw new InvalidWagerTransactionError(
        'amount da OPENING deve ser positivo',
      );
    }

    return new WagerTransaction(
      props.id,
      props.walletId,
      WAGER_TRANSACTION_TYPE_OPENING,
      WAGER_TRANSACTION_STATUS_PROCESSED,
      props.amount,
    );
  }

  /**
   * Reconstrução a partir da persistência — não revalida transições.
   */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.walletId,
      state.type,
      state.status,
      Money.from(state.amount),
    );
  }

  private static assertRequiredId(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidWagerTransactionError(`${field} é obrigatório`);
    }
  }
}
