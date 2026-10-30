import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import dataSource from '../../src/infrastructure/database/data-source';
import { TypeOrmWalletRepository } from '../../src/infrastructure/repository/wallet/typeorm-wallet.repository';
import { WalletOrmEntity } from '../../src/infrastructure/repository/wallet/wallet.orm-entity';

describe('TypeOrmWalletRepository (e2e)', () => {
  let connection: DataSource;
  let repository: TypeOrmWalletRepository;
  const createdIds: string[] = [];

  beforeAll(async () => {
    connection = dataSource;
    if (!connection.isInitialized) {
      await connection.initialize();
    }
    repository = new TypeOrmWalletRepository(
      connection.getRepository(WalletOrmEntity),
    );
  });

  afterEach(async () => {
    if (createdIds.length === 0) {
      return;
    }
    await connection.getRepository(WalletOrmEntity).delete(createdIds);
    createdIds.length = 0;
  });

  afterAll(async () => {
    if (connection?.isInitialized) {
      await connection.destroy();
    }
  });

  it('salva e recupera uma carteira por id via rehydrate', async () => {
    const id = randomUUID();
    const playerId = randomUUID();
    createdIds.push(id);

    const wallet = Wallet.open({
      id,
      playerId,
      initialBalance: Money.from({ amount: '250.75', currency: 'BRL' }),
    });

    await repository.save(wallet);

    const found = await repository.findById(id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
    expect(found!.playerId).toBe(playerId);
    expect(found!.currency).toBe('BRL');
    expect(found!.version).toBe(1);
    expect(found!.balance.toString()).toBe('250.75');
    expect(typeof found!.balance.toString()).toBe('string');
    expect(found!.balance.toJSON()).toEqual({
      amount: '250.75',
      currency: 'BRL',
    });
    expect(found!.balance.toJSON().amount).not.toEqual(expect.any(Number));
  });

  it('retorna null quando a carteira não existe', async () => {
    const found = await repository.findById(randomUUID());
    expect(found).toBeNull();
  });

  it('não converte balance para number ao persistir/ler', async () => {
    const id = randomUUID();
    createdIds.push(id);

    await repository.save(
      Wallet.open({
        id,
        playerId: randomUUID(),
        initialBalance: Money.from({ amount: '0.01', currency: 'EUR' }),
      }),
    );

    const raw = await connection.getRepository(WalletOrmEntity).findOneByOrFail({
      id,
    });

    expect(typeof raw.balance).toBe('string');
    expect(raw.balance).toMatch(/^\d+(\.\d+)?$/);

    const found = await repository.findById(id);
    expect(typeof found!.balance.toString()).toBe('string');
    expect(found!.balance.toString()).toBe('0.01');
  });
});
