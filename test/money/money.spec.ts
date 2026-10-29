import { Money } from '../../src/domain/money/money';
import { InvalidMoneyError } from '../../src/domain/money/money.errors';

describe('Money.from', () => {
  describe('precisão monetária', () => {
    it('aceita amount com até 2 casas e serializa com escala fixa', () => {
      const money = Money.from({ amount: '10.5', currency: 'BRL' });

      expect(money.toString()).toBe('10.50');
      expect(money.toJSON()).toEqual({ amount: '10.50', currency: 'BRL' });
      expect(typeof money.toJSON().amount).toBe('string');
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

      expect(() =>
        Money.from({
          amount: 100 as unknown as string,
          currency: 'BRL',
        }),
      ).toThrow(InvalidMoneyError);
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

      expect(() =>
        Money.from({ amount: '1.00', currency: 'BR' }),
      ).toThrow(InvalidMoneyError);

      expect(() =>
        Money.from({ amount: '1.00', currency: '123' }),
      ).toThrow(InvalidMoneyError);

      expect(() =>
        Money.from({ amount: '1.00', currency: 'B$L' }),
      ).toThrow(InvalidMoneyError);
    });

    it('rejeita currency que não seja string', () => {
      expect(() =>
        Money.from({
          amount: '1.00',
          currency: 123 as unknown as string,
        }),
      ).toThrow(InvalidMoneyError);
    });
  });
});
