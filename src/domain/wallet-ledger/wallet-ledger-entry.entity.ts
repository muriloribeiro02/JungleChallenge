import { Money, type MoneyProps } from '../money/money';
import { InvalidWalletLedgerEntryError } from './wallet-ledger-entry.errors';

export const LEDGER_DIRECTION_CREDIT = 'CREDIT' as const;
export const LEDGER_DIRECTION_DEBIT = 'DEBIT' as const;

export type LedgerDirection =
  | typeof LEDGER_DIRECTION_CREDIT
  | typeof LEDGER_DIRECTION_DEBIT;

export type LedgerEntryMoneyProps = {
  id: string;
  walletId: string;
  transactionId: string;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
};

export type WalletLedgerEntryState = {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date | string;
};

/**
 * Lançamento imutável do ledger da carteira.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {}

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  static credit(props: LedgerEntryMoneyProps): WalletLedgerEntry {
    return WalletLedgerEntry.create(LEDGER_DIRECTION_CREDIT, props);
  }

  static debit(props: LedgerEntryMoneyProps): WalletLedgerEntry {
    return WalletLedgerEntry.create(LEDGER_DIRECTION_DEBIT, props);
  }

  /**
   * Reconstrução a partir da persistência — não revalida regras de criação.
   */
  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.freeze(
      new WalletLedgerEntry(
        state.id,
        state.walletId,
        state.transactionId,
        state.direction,
        Money.from(state.money),
        Money.from(state.balanceBefore),
        Money.from(state.balanceAfter),
        WalletLedgerEntry.toDate(state.createdAt),
      ),
    );
  }

  private static create(
    direction: LedgerDirection,
    props: LedgerEntryMoneyProps,
  ): WalletLedgerEntry {
    WalletLedgerEntry.assertRequiredId(props.id, 'id');
    WalletLedgerEntry.assertRequiredId(props.walletId, 'walletId');
    WalletLedgerEntry.assertRequiredId(props.transactionId, 'transactionId');
    WalletLedgerEntry.assertMoneyInstance(props.money, 'money');
    WalletLedgerEntry.assertMoneyInstance(props.balanceBefore, 'balanceBefore');
    WalletLedgerEntry.assertMoneyInstance(props.balanceAfter, 'balanceAfter');

    if (!props.money.isPositive()) {
      throw new InvalidWalletLedgerEntryError('money deve ser positivo');
    }

    WalletLedgerEntry.assertSameCurrency(
      props.money,
      props.balanceBefore,
      props.balanceAfter,
    );

    if (props.balanceAfter.isNegative()) {
      throw new InvalidWalletLedgerEntryError(
        'balanceAfter não pode ser negativo',
      );
    }

    const expectedAfter =
      direction === LEDGER_DIRECTION_CREDIT
        ? props.balanceBefore.add(props.money)
        : props.balanceBefore.subtract(props.money);

    if (!props.balanceAfter.equals(expectedAfter)) {
      throw new InvalidWalletLedgerEntryError(
        'balanceAfter não corresponde a balanceBefore e money para a direção',
      );
    }

    return WalletLedgerEntry.freeze(
      new WalletLedgerEntry(
        props.id,
        props.walletId,
        props.transactionId,
        direction,
        props.money,
        props.balanceBefore,
        props.balanceAfter,
        new Date(),
      ),
    );
  }

  private static freeze(entry: WalletLedgerEntry): WalletLedgerEntry {
    return Object.freeze(entry);
  }

  private static assertRequiredId(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidWalletLedgerEntryError(`${field} é obrigatório`);
    }
  }

  private static assertMoneyInstance(value: Money, field: string): void {
    if (!(value instanceof Money)) {
      throw new InvalidWalletLedgerEntryError(
        `${field} deve ser uma instância de Money`,
      );
    }
  }

  private static assertSameCurrency(
    money: Money,
    balanceBefore: Money,
    balanceAfter: Money,
  ): void {
    if (
      money.currency !== balanceBefore.currency ||
      money.currency !== balanceAfter.currency
    ) {
      throw new InvalidWalletLedgerEntryError(
        'money, balanceBefore e balanceAfter devem ter a mesma moeda',
      );
    }
  }

  private static toDate(value: Date | string): Date {
    return value instanceof Date ? new Date(value.getTime()) : new Date(value);
  }
}
