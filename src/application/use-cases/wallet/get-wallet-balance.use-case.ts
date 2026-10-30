import type { WalletRepository } from '../../../domain/wallet/wallet.repository';
import { WalletNotFoundError } from './get-wallet-balance.errors';

export type GetWalletBalanceInput = {
  walletId: string;
};

export type GetWalletBalanceOutput = {
  id: string;
  balance: string;
  currency: string;
};

/**
 * Consulta o saldo de uma carteira pelo ID.
 * Depende apenas do contrato WalletRepository (porta de domínio).
 */
export class GetWalletBalanceUseCase {
  constructor(private readonly wallets: WalletRepository) {}

  async execute(input: GetWalletBalanceInput): Promise<GetWalletBalanceOutput> {
    const wallet = await this.wallets.findById(input.walletId);

    if (!wallet) {
      throw new WalletNotFoundError(input.walletId);
    }

    return {
      id: wallet.id,
      balance: wallet.balance.toString(),
      currency: wallet.currency,
    };
  }
}
