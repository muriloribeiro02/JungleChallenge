import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money/money';
import {
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_TYPE_OPENING,
  WagerTransaction,
} from '../../src/domain/wager-transaction/wager-transaction.entity';
import { WagerTransactionMapper } from '../../src/infrastructure/repository/wager-transaction/wager-transaction.mapper';
import { WagerTransactionOrmEntity } from '../../src/infrastructure/repository/wager-transaction/wager-transaction.orm-entity';

describe('WagerTransactionMapper', () => {
  const id = randomUUID();
  const walletId = randomUUID();

  it('persiste e recupera snapshot com escala de 2 casas', () => {
    const tx = WagerTransaction.openingProcessed({
      id,
      walletId,
      amount: Money.from({ amount: '100.00', currency: 'BRL' }),
      snapshot: {
        observedBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
        observedWalletVersion: 1,
      },
    });

    const row = WagerTransactionMapper.toPersistence(tx);
    expect(row.observedBalance).toBe('100.00');
    expect(row.observedWalletVersion).toBe(1);

    // Simula NUMERIC(19,4) no driver
    row.observedBalance = '100.0000';

    const domain = WagerTransactionMapper.toDomain(row);
    expect(domain.observedBalance?.toString()).toBe('100.00');
    expect(domain.observedWalletVersion).toBe(1);
  });

  it('não inventa snapshot para registro legado NULL', () => {
    const row = new WagerTransactionOrmEntity();
    row.id = id;
    row.walletId = walletId;
    row.playerId = null;
    row.kind = WAGER_TRANSACTION_TYPE_OPENING;
    row.status = WAGER_TRANSACTION_STATUS_PROCESSED;
    row.amount = '50.0000';
    row.currency = 'BRL';
    row.providerId = null;
    row.externalTransactionId = null;
    row.idempotencyKey = null;
    row.payloadHash = null;
    row.roundId = null;
    row.gameId = null;
    row.externalReference = null;
    row.resolvedInternalReference = null;
    row.failureCode = null;
    row.observedBalance = null;
    row.observedWalletVersion = null;
    row.createdAt = new Date();
    row.updatedAt = new Date();

    const domain = WagerTransactionMapper.toDomain(row);
    expect(domain.observedBalance).toBeNull();
    expect(domain.observedWalletVersion).toBeNull();
  });

  it('rejeita amount com precisão inválida na reidratação', () => {
    const row = new WagerTransactionOrmEntity();
    row.id = id;
    row.walletId = walletId;
    row.playerId = null;
    row.kind = WAGER_TRANSACTION_TYPE_OPENING;
    row.status = WAGER_TRANSACTION_STATUS_PROCESSED;
    row.amount = '1.2350';
    row.currency = 'BRL';
    row.providerId = null;
    row.externalTransactionId = null;
    row.idempotencyKey = null;
    row.payloadHash = null;
    row.roundId = null;
    row.gameId = null;
    row.externalReference = null;
    row.resolvedInternalReference = null;
    row.failureCode = null;
    row.observedBalance = null;
    row.observedWalletVersion = null;
    row.createdAt = new Date();
    row.updatedAt = new Date();

    expect(() => WagerTransactionMapper.toDomain(row)).toThrow(
      /2 casas decimais/,
    );
  });
});
