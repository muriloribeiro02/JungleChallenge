import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const CURRENCY_REGEX = /^[A-Z]{3}$/;
const FORBIDDEN_AMOUNT_PATTERN = /[eE]|Infinity|NaN/i;

/**
 * Limite alinhado a PostgreSQL NUMERIC(19,2):
 * 19 dígitos no total, 2 fracionários → até 17 dígitos inteiros.
 */
export const MONEY_MAX_ABS_AMOUNT = '99999999999999999.99';

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
});

/**
 * Value Object imutável de dinheiro (escala fixa de 2 casas).
 * Independente de NestJS, ORM e infraestrutura.
 *
 * Nota: NUMERIC(19,2) no PostgreSQL arredonda entradas com >2 casas ao
 * persistir; a validação obrigatória permanece nesta camada (e na API).
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

  /**
   * Reidratação a partir do banco: remove apenas zeros à direita na fração
   * (ex.: "10.5000" → "10.5") e valida via `from`. Não arredonda dígitos
   * significativos além de 2 casas (ex.: "1.2350" falha).
   */
  static fromPersisted(props: MoneyProps): Money {
    return Money.from({
      amount: Money.stripTrailingFractionalZeros(props.amount),
      currency: props.currency,
    });
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.create(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.create(this.value.negated(), this.currency);
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

  /**
   * Único ponto de construção pós-aritmética: permite negativo, rejeita
   * magnitude acima de NUMERIC(19,2). Sem arredondamento.
   */
  private static create(value: Decimal, currency: string): Money {
    Money.assertWithinMagnitude(value);
    return new Money(value, currency);
  }

  private static assertWithinMagnitude(value: Decimal): void {
    const max = new Decimal(MONEY_MAX_ABS_AMOUNT);
    if (value.abs().greaterThan(max)) {
      throw new InvalidMoneyError(
        `amount excede o máximo persistível (${MONEY_MAX_ABS_AMOUNT})`,
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

  private static stripTrailingFractionalZeros(amount: string): string {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal');
    }
    const trimmed = amount.trim();
    if (trimmed === '') {
      throw new InvalidMoneyError('amount não pode ser vazio');
    }
    if (!trimmed.includes('.')) {
      return trimmed;
    }
    const [integerPart, fractionPart = ''] = trimmed.split('.');
    const stripped = fractionPart.replace(/0+$/, '');
    if (stripped.length === 0) {
      return integerPart;
    }
    return `${integerPart}.${stripped}`;
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
      // Escala já validada (≤2 casas); toDecimalPlaces(2) só normaliza
      // representação — não arredonda dígitos além do permitido.
      const parsed = new Decimal(trimmed).toDecimalPlaces(2);
      Money.assertWithinMagnitude(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof InvalidMoneyError) {
        throw error;
      }
      throw new InvalidMoneyError('amount não pôde ser interpretado');
    }
  }
}
