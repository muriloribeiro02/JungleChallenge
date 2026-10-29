import { Money, type MoneyProps } from '../money/money';
import {
  InvalidWalletError,
  WalletCurrencyMismatchError,
} from './wallet.errors';

export type OpenWalletProps = {
  id: string;
  playerId: string;
  initialBalance: Money;
};

export type WalletState = {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/**
 * Aggregate Root da carteira do jogador.
 * Independente de NestJS, ORM, banco e infraestrutura.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Factory de criação controlada da carteira.
   * `version` inicia em 1; saldo inicial não pode ser negativo.
   */
  static open(props: OpenWalletProps): Wallet {
    Wallet.assertRequiredId(props.id, 'id');
    Wallet.assertRequiredId(props.playerId, 'playerId');

    if (!(props.initialBalance instanceof Money)) {
      throw new InvalidWalletError(
        'initialBalance deve ser uma instância de Money',
      );
    }

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initialBalance não pode ser negativo');
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /**
   * Reconstrução a partir da persistência — não revalida transições.
   */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      Wallet.toDate(state.createdAt),
      Wallet.toDate(state.updatedAt),
    );
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new WalletCurrencyMismatchError(
        `a moeda da operação (${money.currency}) não corresponde à moeda da wallet (${this.currency})`,
      );
    }
  }

  private static assertRequiredId(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidWalletError(`${field} é obrigatório`);
    }
  }

  private static toDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
  }
}
