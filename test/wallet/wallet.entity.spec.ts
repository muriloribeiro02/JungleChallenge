import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import { InvalidWalletError } from '../../src/domain/wallet/wallet.errors';

describe('Wallet (Aggregate Root)', () => {
  const id = randomUUID();
  const playerId = randomUUID();

  describe('open', () => {
    it('abre uma wallet com version = 1 e saldo inicial', () => {
      const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });

      const wallet = Wallet.open({
        id,
        playerId,
        initialBalance,
      });

      expect(wallet.id).toBe(id);
      expect(wallet.playerId).toBe(playerId);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.equals(initialBalance)).toBe(true);
      expect(wallet.balance.toJSON()).toEqual({
        amount: '100.00',
        currency: 'BRL',
      });
      expect(wallet.createdAt).toBeInstanceOf(Date);
      expect(wallet.updatedAt).toBeInstanceOf(Date);
      expect(typeof wallet.balance.toString()).toBe('string');
    });

    it('permite saldo inicial zero', () => {
      const wallet = Wallet.open({
        id,
        playerId,
        initialBalance: Money.zero('USD'),
      });

      expect(wallet.currency).toBe('USD');
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it('deriva a moeda a partir do Money inicial', () => {
      const wallet = Wallet.open({
        id,
        playerId,
        initialBalance: Money.from({ amount: '10.50', currency: 'eur' }),
      });

      expect(wallet.currency).toBe('EUR');
      expect(wallet.balance.toString()).toBe('10.50');
    });

    it('rejeita saldo inicial negativo', () => {
      const negativeBalance = Money.from({
        amount: '25.00',
        currency: 'BRL',
      }).negate();

      expect(() =>
        Wallet.open({
          id,
          playerId,
          initialBalance: negativeBalance,
        }),
      ).toThrow(InvalidWalletError);
    });

    it('rejeita id vazio', () => {
      expect(() =>
        Wallet.open({
          id: '   ',
          playerId,
          initialBalance: Money.zero('BRL'),
        }),
      ).toThrow(InvalidWalletError);
    });

    it('rejeita playerId vazio', () => {
      expect(() =>
        Wallet.open({
          id,
          playerId: '',
          initialBalance: Money.zero('BRL'),
        }),
      ).toThrow(InvalidWalletError);
    });

    it('rejeita initialBalance que não seja Money', () => {
      expect(() =>
        Wallet.open({
          id,
          playerId,
          initialBalance: {
            amount: '10.00',
            currency: 'BRL',
          } as unknown as Money,
        }),
      ).toThrow(InvalidWalletError);
    });

    it('não usa number no saldo', () => {
      const wallet = Wallet.open({
        id,
        playerId,
        initialBalance: Money.from({ amount: '99.99', currency: 'BRL' }),
      });

      expect(wallet.balance.toJSON().amount).toEqual(expect.any(String));
      expect(wallet.balance.toJSON().amount).not.toEqual(expect.any(Number));
    });
  });

  describe('credit', () => {
    it('credita valor positivo e incrementa version', () => {
      const wallet = Wallet.open({
        id,
        playerId,
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });

      wallet.credit(Money.from({ amount: '25.00', currency: 'BRL' }));

      expect(wallet.balance.toString()).toBe('125.00');
      expect(wallet.version).toBe(2);
    });

    it('rejeita amount não positivo', () => {
      const wallet = Wallet.open({
        id,
        playerId,
        initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      });

      expect(() => wallet.credit(Money.zero('BRL'))).toThrow(InvalidWalletError);
    });

    it('rejeita moeda diferente', () => {
      const wallet = Wallet.open({
        id,
        playerId,
        initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      });

      expect(() =>
        wallet.credit(Money.from({ amount: '1.00', currency: 'USD' })),
      ).toThrow();
    });
  });

  describe('rehydrate', () => {
    it('reconstrói o estado persistido sem alterar version', () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const updatedAt = new Date('2026-01-02T00:00:00.000Z');

      const wallet = Wallet.rehydrate({
        id,
        playerId,
        currency: 'BRL',
        balance: { amount: '50.00', currency: 'BRL' },
        version: 3,
        createdAt,
        updatedAt,
      });

      expect(wallet.id).toBe(id);
      expect(wallet.playerId).toBe(playerId);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.version).toBe(3);
      expect(wallet.balance.toString()).toBe('50.00');
      expect(wallet.createdAt).toEqual(createdAt);
      expect(wallet.updatedAt).toEqual(updatedAt);
    });
  });
});
