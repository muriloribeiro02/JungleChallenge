import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money/money';
import {
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_TYPE_OPENING,
  WagerTransaction,
} from '../../src/domain/wager-transaction/wager-transaction.entity';
import { InvalidWagerTransactionError } from '../../src/domain/wager-transaction/wager-transaction.errors';

describe('WagerTransaction', () => {
  const id = randomUUID();
  const walletId = randomUUID();

  describe('openingProcessed', () => {
    it('cria OPENING PROCESSED com amount Money positivo (ex.: R$ 100,00)', () => {
      const amount = Money.from({ amount: '100.00', currency: 'BRL' });

      const tx = WagerTransaction.openingProcessed({
        id,
        walletId,
        amount,
      });

      expect(tx.id).toBe(id);
      expect(tx.walletId).toBe(walletId);
      expect(tx.type).toBe(WAGER_TRANSACTION_TYPE_OPENING);
      expect(tx.status).toBe(WAGER_TRANSACTION_STATUS_PROCESSED);
      expect(tx.amount.equals(amount)).toBe(true);
      expect(tx.amount.toString()).toBe('100.00');
      expect(typeof tx.amount.toString()).toBe('string');
      expect(tx.amount.toJSON().amount).not.toEqual(expect.any(Number));
    });

    it('rejeita amount zero', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: Money.zero('BRL'),
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita amount negativo', () => {
      const negative = Money.from({ amount: '10.00', currency: 'BRL' }).negate();

      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: negative,
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita amount que não seja Money', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: { amount: '100.00', currency: 'BRL' } as unknown as Money,
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita id vazio', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id: '  ',
          walletId,
          amount: Money.from({ amount: '100.00', currency: 'BRL' }),
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita walletId vazio', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId: '',
          amount: Money.from({ amount: '100.00', currency: 'BRL' }),
        }),
      ).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('rehydrate', () => {
    it('reconstrói estado persistido', () => {
      const tx = WagerTransaction.rehydrate({
        id,
        walletId,
        type: WAGER_TRANSACTION_TYPE_OPENING,
        status: WAGER_TRANSACTION_STATUS_PROCESSED,
        amount: { amount: '100.00', currency: 'BRL' },
      });

      expect(tx.type).toBe('OPENING');
      expect(tx.status).toBe('PROCESSED');
      expect(tx.amount.toString()).toBe('100.00');
    });
  });
});
