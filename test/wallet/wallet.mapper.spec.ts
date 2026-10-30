import { randomUUID } from 'node:crypto';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import { WalletMapper } from '../../src/infrastructure/repository/wallet/wallet.mapper';
import { WalletOrmEntity } from '../../src/infrastructure/repository/wallet/wallet.orm-entity';

describe('WalletMapper', () => {
  it('converte domínio → persistência preservando balance como string', () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '100.50', currency: 'BRL' }),
    });

    const row = WalletMapper.toPersistence(wallet);

    expect(row.id).toBe(wallet.id);
    expect(row.playerId).toBe(wallet.playerId);
    expect(row.currency).toBe('BRL');
    expect(row.balance).toBe('100.50');
    expect(typeof row.balance).toBe('string');
    expect(row.version).toBe(1);
    expect(row.createdAt).toEqual(wallet.createdAt);
    expect(row.updatedAt).toEqual(wallet.updatedAt);
  });

  it('reconstrói domínio via Wallet.rehydrate a partir do NUMERIC com 4 casas', () => {
    const row = new WalletOrmEntity();
    row.id = randomUUID();
    row.playerId = randomUUID();
    row.currency = 'BRL';
    row.balance = '100.5000';
    row.version = 2;
    row.createdAt = new Date('2026-01-01T00:00:00.000Z');
    row.updatedAt = new Date('2026-01-02T00:00:00.000Z');

    const wallet = WalletMapper.toDomain(row);

    expect(wallet.id).toBe(row.id);
    expect(wallet.playerId).toBe(row.playerId);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('100.50');
    expect(typeof wallet.balance.toString()).toBe('string');
    expect(wallet.version).toBe(2);
    expect(wallet.createdAt).toEqual(row.createdAt);
    expect(wallet.updatedAt).toEqual(row.updatedAt);
  });

  it('ida e volta domínio → ORM → domínio preserva valores monetários', () => {
    const original = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '19.99', currency: 'USD' }),
    });

    const restored = WalletMapper.toDomain(WalletMapper.toPersistence(original));

    expect(restored.id).toBe(original.id);
    expect(restored.playerId).toBe(original.playerId);
    expect(restored.currency).toBe('USD');
    expect(restored.balance.equals(original.balance)).toBe(true);
    expect(restored.version).toBe(1);
    expect(restored.balance.toJSON().amount).not.toEqual(expect.any(Number));
  });
});
