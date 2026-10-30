import type { WalletRepository } from '../../../domain/wallet/wallet.repository';
import { WalletNotFoundError } from './get-wallet-balance.errors';

export type GetWalletInput = {
  walletId: string;
};

export type GetWalletOutput = {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
};

/**
 * Consulta wallet no formato do contrato HTTP GET /wallets/:walletId.
 */
export class GetWalletUseCase {
  constructor(private readonly wallets: WalletRepository) {}

  async execute(input: GetWalletInput): Promise<GetWalletOutput> {
    const wallet = await this.wallets.findById(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(input.walletId);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
