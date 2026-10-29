import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const CURRENCY_REGEX = /^[A-Z]{3}$/;
const FORBIDDEN_AMOUNT_PATTERN = /[eE]|Infinity|NaN/i;

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * Value Object imutável de dinheiro (escala fixa de 2 casas).
 * Independente de NestJS, ORM e infraestrutura.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = Money.normalizeCurrency(props.currency);
    const amount = Money.parseAmount(props.amount);

    if (amount.isNegative()) {
      throw new InvalidMoneyError('amount não pode ser negativo');
    }

    return new Money(amount, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `moedas incompatíveis: ${this.currency} vs ${other.currency}`,
      );
    }
  }

  private static normalizeCurrency(currency: string): string {
    if (typeof currency !== 'string' || currency.trim() === '') {
      throw new InvalidMoneyError('currency é obrigatória');
    }

    const normalized = currency.trim().toUpperCase();
    if (!CURRENCY_REGEX.test(normalized)) {
      throw new InvalidMoneyError(
        'currency deve ser um código ISO-4217 de 3 letras (ex.: BRL)',
      );
    }

    return normalized;
  }

  private static parseAmount(amount: string): Decimal {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal');
    }

    const trimmed = amount.trim();
    if (trimmed === '') {
      throw new InvalidMoneyError('amount não pode ser vazio');
    }

    if (FORBIDDEN_AMOUNT_PATTERN.test(trimmed)) {
      throw new InvalidMoneyError('amount possui formato numérico inválido');
    }

    if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      throw new InvalidMoneyError(
        'amount deve ser uma string decimal simples',
      );
    }

    const decimalPart = trimmed.includes('.') ? trimmed.split('.')[1] : '';
    if (decimalPart.length > 2) {
      throw new InvalidMoneyError(
        'amount deve ter no máximo 2 casas decimais',
      );
    }

    try {
      return new Decimal(trimmed).toDecimalPlaces(2);
    } catch {
      throw new InvalidMoneyError('amount não pôde ser interpretado');
    }
  }
}
