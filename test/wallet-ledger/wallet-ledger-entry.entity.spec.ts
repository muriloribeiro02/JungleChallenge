import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money/money';
import {
  LEDGER_DIRECTION_CREDIT,
  LEDGER_DIRECTION_DEBIT,
  WalletLedgerEntry,
} from '../../src/domain/wallet-ledger/wallet-ledger-entry.entity';
import { InvalidWalletLedgerEntryError } from '../../src/domain/wallet-ledger/wallet-ledger-entry.errors';

describe('WalletLedgerEntry', () => {
  const id = randomUUID();
  const walletId = randomUUID();
  const transactionId = randomUUID();

  describe('credit', () => {
    it('cria crédito válido (0 + 100 = 100 BRL)', () => {
      const money = Money.from({ amount: '100.00', currency: 'BRL' });
      const balanceBefore = Money.zero('BRL');
      const balanceAfter = Money.from({ amount: '100.00', currency: 'BRL' });

      const entry = WalletLedgerEntry.credit({
        id,
        walletId,
        transactionId,
        money,
        balanceBefore,
        balanceAfter,
      });

      expect(entry.id).toBe(id);
      expect(entry.walletId).toBe(walletId);
      expect(entry.transactionId).toBe(transactionId);
      expect(entry.direction).toBe(LEDGER_DIRECTION_CREDIT);
      expect(entry.money.toString()).toBe('100.00');
      expect(entry.balanceBefore.toString()).toBe('0.00');
      expect(entry.balanceAfter.toString()).toBe('100.00');
      expect(entry.createdAt).toBeInstanceOf(Date);
      expect(typeof entry.money.toString()).toBe('string');
      expect(entry.money.toJSON().amount).not.toEqual(expect.any(Number));
    });

    it('rejeita money não positivo', () => {
      expect(() =>
        WalletLedgerEntry.credit({
          id,
          walletId,
          transactionId,
          money: Money.zero('BRL'),
          balanceBefore: Money.zero('BRL'),
          balanceAfter: Money.zero('BRL'),
        }),
      ).toThrow(InvalidWalletLedgerEntryError);
    });
  });

  describe('debit', () => {
    it('cria débito válido (100 - 40 = 60 BRL)', () => {
      const entry = WalletLedgerEntry.debit({
        id,
        walletId,
        transactionId,
        money: Money.from({ amount: '40.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '60.00', currency: 'BRL' }),
      });

      expect(entry.direction).toBe(LEDGER_DIRECTION_DEBIT);
      expect(entry.money.toString()).toBe('40.00');
      expect(entry.balanceBefore.toString()).toBe('100.00');
      expect(entry.balanceAfter.toString()).toBe('60.00');
    });

    it('rejeita money não positivo', () => {
      const negative = Money.from({ amount: '10.00', currency: 'BRL' }).negate();

      expect(() =>
        WalletLedgerEntry.debit({
          id,
          walletId,
          transactionId,
          money: negative,
          balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
          balanceAfter: Money.from({ amount: '110.00', currency: 'BRL' }),
        }),
      ).toThrow(InvalidWalletLedgerEntryError);
    });
  });

  describe('validações', () => {
    it('rejeita moedas incompatíveis', () => {
      expect(() =>
        WalletLedgerEntry.credit({
          id,
          walletId,
          transactionId,
          money: Money.from({ amount: '100.00', currency: 'BRL' }),
          balanceBefore: Money.zero('USD'),
          balanceAfter: Money.from({ amount: '100.00', currency: 'BRL' }),
        }),
      ).toThrow(InvalidWalletLedgerEntryError);
    });

    it('rejeita balanceAfter incorreto no crédito', () => {
      expect(() =>
        WalletLedgerEntry.credit({
          id,
          walletId,
          transactionId,
          money: Money.from({ amount: '100.00', currency: 'BRL' }),
          balanceBefore: Money.zero('BRL'),
          balanceAfter: Money.from({ amount: '99.00', currency: 'BRL' }),
        }),
      ).toThrow(InvalidWalletLedgerEntryError);
    });

    it('rejeita balanceAfter incorreto no débito', () => {
      expect(() =>
        WalletLedgerEntry.debit({
          id,
          walletId,
          transactionId,
          money: Money.from({ amount: '40.00', currency: 'BRL' }),
          balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
          balanceAfter: Money.from({ amount: '50.00', currency: 'BRL' }),
        }),
      ).toThrow(InvalidWalletLedgerEntryError);
    });

    it('rejeita balanceAfter negativo', () => {
      const negativeAfter = Money.from({
        amount: '10.00',
        currency: 'BRL',
      }).negate();

      expect(() =>
        WalletLedgerEntry.debit({
          id,
          walletId,
          transactionId,
          money: Money.from({ amount: '50.00', currency: 'BRL' }),
          balanceBefore: Money.from({ amount: '40.00', currency: 'BRL' }),
          balanceAfter: negativeAfter,
        }),
      ).toThrow(InvalidWalletLedgerEntryError);
    });

    it('rejeita ids vazios', () => {
      const money = Money.from({ amount: '10.00', currency: 'BRL' });
      const balanceBefore = Money.zero('BRL');
      const balanceAfter = Money.from({ amount: '10.00', currency: 'BRL' });

      expect(() =>
        WalletLedgerEntry.credit({
          id: '',
          walletId,
          transactionId,
          money,
          balanceBefore,
          balanceAfter,
        }),
      ).toThrow(InvalidWalletLedgerEntryError);

      expect(() =>
        WalletLedgerEntry.credit({
          id,
          walletId: ' ',
          transactionId,
          money,
          balanceBefore,
          balanceAfter,
        }),
      ).toThrow(InvalidWalletLedgerEntryError);

      expect(() =>
        WalletLedgerEntry.credit({
          id,
          walletId,
          transactionId: '',
          money,
          balanceBefore,
          balanceAfter,
        }),
      ).toThrow(InvalidWalletLedgerEntryError);
    });
  });

  describe('imutabilidade', () => {
    it('congela a instância e não expõe Date mutável interno', () => {
      const entry = WalletLedgerEntry.credit({
        id,
        walletId,
        transactionId,
        money: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceBefore: Money.zero('BRL'),
        balanceAfter: Money.from({ amount: '100.00', currency: 'BRL' }),
      });

      expect(Object.isFrozen(entry)).toBe(true);

      expect(() => {
        (entry as { walletId: string }).walletId = randomUUID();
      }).toThrow();

      const first = entry.createdAt;
      const second = entry.createdAt;
      expect(first).not.toBe(second);
      expect(first.getTime()).toBe(second.getTime());

      first.setTime(0);
      expect(entry.createdAt.getTime()).not.toBe(0);
    });
  });

  describe('rehydrate', () => {
    it('reconstrói estado persistido sem revalidar equação', () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');

      const entry = WalletLedgerEntry.rehydrate({
        id,
        walletId,
        transactionId,
        direction: LEDGER_DIRECTION_CREDIT,
        money: { amount: '100.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        createdAt,
      });

      expect(entry.direction).toBe(LEDGER_DIRECTION_CREDIT);
      expect(entry.money.toString()).toBe('100.00');
      expect(entry.createdAt).toEqual(createdAt);
      expect(Object.isFrozen(entry)).toBe(true);
    });
  });
});
