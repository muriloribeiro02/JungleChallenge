import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money/money';
import type { OperationResultSnapshot } from '../../src/domain/wager-transaction/operation-result-snapshot';
import {
  FAILURE_CODE_INSUFFICIENT_FUNDS,
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_STATUS_REJECTED,
  WAGER_TRANSACTION_TYPE_BET,
  WAGER_TRANSACTION_TYPE_OPENING,
  WagerTransaction,
} from '../../src/domain/wager-transaction/wager-transaction.entity';
import { InvalidWagerTransactionError } from '../../src/domain/wager-transaction/wager-transaction.errors';

describe('WagerTransaction', () => {
  const id = randomUUID();
  const walletId = randomUUID();

  const validSnapshot = (): OperationResultSnapshot => ({
    observedBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    observedWalletVersion: 1,
  });

  describe('openingProcessed', () => {
    it('cria OPENING PROCESSED com amount Money positivo e snapshot', () => {
      const amount = Money.from({ amount: '100.00', currency: 'BRL' });
      const snapshot = validSnapshot();

      const tx = WagerTransaction.openingProcessed({
        id,
        walletId,
        amount,
        snapshot,
      });

      expect(tx.id).toBe(id);
      expect(tx.walletId).toBe(walletId);
      expect(tx.type).toBe(WAGER_TRANSACTION_TYPE_OPENING);
      expect(tx.status).toBe(WAGER_TRANSACTION_STATUS_PROCESSED);
      expect(tx.amount.equals(amount)).toBe(true);
      expect(tx.observedBalance?.equals(snapshot.observedBalance)).toBe(true);
      expect(tx.observedWalletVersion).toBe(1);
    });

    it('rejeita snapshot ausente', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: Money.from({ amount: '100.00', currency: 'BRL' }),
          snapshot: undefined as unknown as OperationResultSnapshot,
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita observedBalance negativo', () => {
      const negative = Money.from({ amount: '10.00', currency: 'BRL' }).negate();

      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: Money.from({ amount: '100.00', currency: 'BRL' }),
          snapshot: {
            observedBalance: negative,
            observedWalletVersion: 1,
          },
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita observedWalletVersion zero', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: Money.from({ amount: '100.00', currency: 'BRL' }),
          snapshot: {
            observedBalance: Money.zero('BRL'),
            observedWalletVersion: 0,
          },
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita observedWalletVersion negativo', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: Money.from({ amount: '100.00', currency: 'BRL' }),
          snapshot: {
            observedBalance: Money.zero('BRL'),
            observedWalletVersion: -1,
          },
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita observedBalance com currency diferente da transação', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: Money.from({ amount: '100.00', currency: 'BRL' }),
          snapshot: {
            observedBalance: Money.from({ amount: '100.00', currency: 'USD' }),
            observedWalletVersion: 1,
          },
        }),
      ).toThrow(/currency/);
    });

    it('aceita observedBalance zero', () => {
      const tx = WagerTransaction.openingProcessed({
        id,
        walletId,
        amount: Money.from({ amount: '100.00', currency: 'BRL' }),
        snapshot: {
          observedBalance: Money.zero('BRL'),
          observedWalletVersion: 1,
        },
      });

      expect(tx.observedBalance?.isZero()).toBe(true);
    });

    it('rejeita amount zero', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: Money.zero('BRL'),
          snapshot: validSnapshot(),
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
          snapshot: validSnapshot(),
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita amount que não seja Money', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId,
          amount: { amount: '100.00', currency: 'BRL' } as unknown as Money,
          snapshot: validSnapshot(),
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita id vazio', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id: '  ',
          walletId,
          amount: Money.from({ amount: '100.00', currency: 'BRL' }),
          snapshot: validSnapshot(),
        }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('rejeita walletId vazio', () => {
      expect(() =>
        WagerTransaction.openingProcessed({
          id,
          walletId: '',
          amount: Money.from({ amount: '100.00', currency: 'BRL' }),
          snapshot: validSnapshot(),
        }),
      ).toThrow(InvalidWagerTransactionError);
    });
  });

  describe('betProcessed / betRejectedInsufficientFunds', () => {
    const externalBase = {
      id,
      walletId,
      playerId: randomUUID(),
      amount: Money.from({ amount: '25.00', currency: 'BRL' }),
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      payloadHash: 'hash-abc',
      roundId: 'round-1',
      gameId: 'game-1',
    };

    it('betProcessed exige snapshot e persiste getters', () => {
      const snapshot = {
        observedBalance: Money.from({ amount: '75.00', currency: 'BRL' }),
        observedWalletVersion: 2,
      };

      const tx = WagerTransaction.betProcessed({ ...externalBase, snapshot });

      expect(tx.type).toBe(WAGER_TRANSACTION_TYPE_BET);
      expect(tx.status).toBe(WAGER_TRANSACTION_STATUS_PROCESSED);
      expect(tx.observedBalance?.toString()).toBe('75.00');
      expect(tx.observedWalletVersion).toBe(2);
    });

    it('betRejectedInsufficientFunds exige snapshot', () => {
      const snapshot = validSnapshot();
      const tx = WagerTransaction.betRejectedInsufficientFunds({
        ...externalBase,
        snapshot,
      });

      expect(tx.status).toBe(WAGER_TRANSACTION_STATUS_REJECTED);
      expect(tx.failureCode).toBe(FAILURE_CODE_INSUFFICIENT_FUNDS);
      expect(tx.observedWalletVersion).toBe(1);
    });

    it('betProcessed sem snapshot falha', () => {
      expect(() =>
        WagerTransaction.betProcessed({
          ...externalBase,
          snapshot: null as unknown as OperationResultSnapshot,
        }),
      ).toThrow(/snapshot/);
    });
  });

  describe('rehydrate', () => {
    it('reconstrói estado persistido legado sem snapshot (NULL)', () => {
      const tx = WagerTransaction.rehydrate({
        id,
        walletId,
        playerId: null,
        type: WAGER_TRANSACTION_TYPE_OPENING,
        status: WAGER_TRANSACTION_STATUS_PROCESSED,
        amount: { amount: '100.00', currency: 'BRL' },
        providerId: null,
        externalTransactionId: null,
        idempotencyKey: null,
        payloadHash: null,
        roundId: null,
        gameId: null,
        failureCode: null,
      });

      expect(tx.type).toBe('OPENING');
      expect(tx.status).toBe('PROCESSED');
      expect(tx.amount.toString()).toBe('100.00');
      expect(tx.observedBalance).toBeNull();
      expect(tx.observedWalletVersion).toBeNull();
    });

    it('reconstrói com snapshot válido', () => {
      const tx = WagerTransaction.rehydrate({
        id,
        walletId,
        playerId: null,
        type: WAGER_TRANSACTION_TYPE_OPENING,
        status: WAGER_TRANSACTION_STATUS_PROCESSED,
        amount: { amount: '100.00', currency: 'BRL' },
        providerId: null,
        externalTransactionId: null,
        idempotencyKey: null,
        payloadHash: null,
        roundId: null,
        gameId: null,
        failureCode: null,
        observedBalance: { amount: '100.00', currency: 'BRL' },
        observedWalletVersion: 1,
      });

      expect(tx.observedBalance?.toString()).toBe('100.00');
      expect(tx.observedWalletVersion).toBe(1);
    });

    it('rejeita snapshot parcial (só balance)', () => {
      expect(() =>
        WagerTransaction.rehydrate({
          id,
          walletId,
          playerId: null,
          type: WAGER_TRANSACTION_TYPE_OPENING,
          status: WAGER_TRANSACTION_STATUS_PROCESSED,
          amount: { amount: '100.00', currency: 'BRL' },
          providerId: null,
          externalTransactionId: null,
          idempotencyKey: null,
          payloadHash: null,
          roundId: null,
          gameId: null,
          failureCode: null,
          observedBalance: { amount: '100.00', currency: 'BRL' },
          observedWalletVersion: null,
        }),
      ).toThrow(InvalidWagerTransactionError);
    });
  });
});
