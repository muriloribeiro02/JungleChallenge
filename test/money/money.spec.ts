import {
  Money,
  MONEY_MAX_ABS_AMOUNT,
} from '../../src/domain/money/money';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../../src/domain/money/money.errors';

describe('Money', () => {
  describe('Money.from — precisão e serialização', () => {
    it('aceita amount com uma casa e serializa com escala fixa 2', () => {
      const money = Money.from({ amount: '10.5', currency: 'BRL' });
      expect(money.toString()).toBe('10.50');
      expect(money.toJSON()).toEqual({ amount: '10.50', currency: 'BRL' });
      expect(typeof money.toJSON().amount).toBe('string');
    });

    it('aceita amount com duas casas', () => {
      const money = Money.from({ amount: '19.99', currency: 'BRL' });
      expect(money.toString()).toBe('19.99');
    });

    it('rejeita amount com mais de 2 casas decimais', () => {
      expect(() =>
        Money.from({ amount: '1.234', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
      expect(() =>
        Money.from({ amount: '10.999', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejeita amount recebido como number', () => {
      expect(() =>
        Money.from({
          amount: 10.5 as unknown as string,
          currency: 'BRL',
        }),
      ).toThrow(InvalidMoneyError);
    });
  });

  describe('Money.from — entradas inválidas', () => {
    it('rejeita NaN', () => {
      expect(() =>
        Money.from({ amount: 'NaN', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejeita Infinity e -Infinity', () => {
      expect(() =>
        Money.from({ amount: 'Infinity', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
      expect(() =>
        Money.from({ amount: '-Infinity', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejeita string vazia e só espaços', () => {
      expect(() =>
        Money.from({ amount: '', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
      expect(() =>
        Money.from({ amount: '   ', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it('aceita espaços em torno de valor válido', () => {
      const money = Money.from({ amount: '  1.00  ', currency: 'BRL' });
      expect(money.toString()).toBe('1.00');
    });

    it('rejeita notação científica', () => {
      expect(() =>
        Money.from({ amount: '1e3', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
      expect(() =>
        Money.from({ amount: '1E-2', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejeita valor negativo na entrada', () => {
      expect(() =>
        Money.from({ amount: '-1.00', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejeita magnitude acima de NUMERIC(19,2)', () => {
      expect(() =>
        Money.from({ amount: '100000000000000000.00', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
      expect(() =>
        Money.from({ amount: '999999999999999999.99', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it('aceita o máximo persistível', () => {
      const money = Money.from({
        amount: MONEY_MAX_ABS_AMOUNT,
        currency: 'BRL',
      });
      expect(money.toString()).toBe(MONEY_MAX_ABS_AMOUNT);
    });
  });

  describe('Money.fromPersisted', () => {
    it('aceita zeros à direita na fração vindos do NUMERIC', () => {
      const money = Money.fromPersisted({
        amount: '100.5000',
        currency: 'BRL',
      });
      expect(money.toString()).toBe('100.50');
    });

    it('rejeita dígitos significativos além de 2 casas (sem arredondar)', () => {
      expect(() =>
        Money.fromPersisted({ amount: '1.2350', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
      expect(() =>
        Money.fromPersisted({ amount: '10.5010', currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });
  });

  describe('operações', () => {
    it('add soma valores da mesma moeda', () => {
      const a = Money.from({ amount: '10.00', currency: 'BRL' });
      const b = Money.from({ amount: '2.50', currency: 'BRL' });
      const sum = a.add(b);
      expect(sum.toString()).toBe('12.50');
      expect(sum.currency).toBe('BRL');
    });

    it('subtract permite resultado negativo no VO interno', () => {
      const a = Money.from({ amount: '1.00', currency: 'BRL' });
      const b = Money.from({ amount: '3.00', currency: 'BRL' });
      const result = a.subtract(b);
      expect(result.isNegative()).toBe(true);
      expect(result.toString()).toBe('-2.00');
    });

    it('negate inverte o sinal', () => {
      const money = Money.from({ amount: '5.00', currency: 'BRL' });
      expect(money.negate().toString()).toBe('-5.00');
      expect(money.negate().negate().toString()).toBe('5.00');
    });

    it('add/subtract rejeitam moedas diferentes', () => {
      const brl = Money.from({ amount: '1.00', currency: 'BRL' });
      const usd = Money.from({ amount: '1.00', currency: 'USD' });
      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe('operações — magnitude NUMERIC(19,2)', () => {
    const max = () =>
      Money.from({ amount: MONEY_MAX_ABS_AMOUNT, currency: 'BRL' });
    const penny = () => Money.from({ amount: '0.01', currency: 'BRL' });
    const zero = () => Money.zero('BRL');

    it('MAX + 0.01 falha', () => {
      expect(() => max().add(penny())).toThrow(InvalidMoneyError);
    });

    it('MAX + 0 funciona', () => {
      expect(max().add(zero()).toString()).toBe(MONEY_MAX_ABS_AMOUNT);
    });

    it('MAX - (-MAX) falha (2×MAX)', () => {
      const negativeMax = max().negate();
      expect(negativeMax.toString()).toBe(`-${MONEY_MAX_ABS_AMOUNT}`);
      expect(() => max().subtract(negativeMax)).toThrow(InvalidMoneyError);
    });

    it('negate(MAX) funciona', () => {
      const negated = max().negate();
      expect(negated.isNegative()).toBe(true);
      expect(negated.toString()).toBe(`-${MONEY_MAX_ABS_AMOUNT}`);
      expect(negated.currency).toBe('BRL');
    });

    it('negate(-MAX) funciona', () => {
      const restored = max().negate().negate();
      expect(restored.toString()).toBe(MONEY_MAX_ABS_AMOUNT);
      expect(restored.currency).toBe('BRL');
    });

    it('operações dentro do limite preservam precisão e moeda', () => {
      const a = Money.from({ amount: '19.99', currency: 'USD' });
      const b = Money.from({ amount: '0.01', currency: 'USD' });
      expect(a.add(b).toString()).toBe('20.00');
      expect(a.add(b).currency).toBe('USD');
      expect(a.subtract(b).toString()).toBe('19.98');
      expect(a.subtract(b).currency).toBe('USD');
    });
  });

  describe('validação de moeda', () => {
    it('normaliza currency para maiúsculo quando válida', () => {
      const money = Money.from({ amount: '1.00', currency: 'usd' });
      expect(money.currency).toBe('USD');
    });

    it('rejeita currency vazia', () => {
      expect(() =>
        Money.from({ amount: '1.00', currency: '' }),
      ).toThrow(InvalidMoneyError);
      expect(() =>
        Money.from({ amount: '1.00', currency: '   ' }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejeita currency que não seja ISO-4217 de 3 letras', () => {
      expect(() =>
        Money.from({ amount: '1.00', currency: 'REAL' }),
      ).toThrow(InvalidMoneyError);
    });
  });
});
