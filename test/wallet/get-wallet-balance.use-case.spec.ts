import { randomUUID } from 'node:crypto';
import { GetWalletBalanceUseCase } from '../../src/application/use-cases/wallet/get-wallet-balance.use-case';
import { WalletNotFoundError } from '../../src/application/use-cases/wallet/get-wallet-balance.errors';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import type { WalletRepository } from '../../src/domain/wallet/wallet.repository';

class InMemoryWalletRepository implements WalletRepository {
  private readonly items = new Map<string, Wallet>();

  seed(wallet: Wallet): void {
    this.items.set(wallet.id, wallet);
  }

  async save(wallet: Wallet): Promise<void> {
    this.items.set(wallet.id, wallet);
  }

  async findById(id: string): Promise<Wallet | null> {
    return this.items.get(id) ?? null;
  }
}

describe('GetWalletBalanceUseCase', () => {
  it('retorna id, saldo string e moeda quando a carteira existe', async () => {
    const repository = new InMemoryWalletRepository();
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '150.25', currency: 'BRL' }),
    });
    repository.seed(wallet);

    const useCase = new GetWalletBalanceUseCase(repository);
    const result = await useCase.execute({ walletId: wallet.id });

    expect(result).toEqual({
      id: wallet.id,
      balance: '150.25',
      currency: 'BRL',
    });
    expect(typeof result.balance).toBe('string');
    expect(result.balance).not.toEqual(expect.any(Number));
  });

  it('lança WalletNotFoundError quando a carteira não existe', async () => {
    const repository = new InMemoryWalletRepository();
    const useCase = new GetWalletBalanceUseCase(repository);
    const missingId = randomUUID();

    await expect(useCase.execute({ walletId: missingId })).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    await expect(useCase.execute({ walletId: missingId })).rejects.toThrow(
      `Carteira não encontrada: ${missingId}`,
    );
  });
});
