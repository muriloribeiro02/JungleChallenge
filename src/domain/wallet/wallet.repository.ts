import type { Wallet } from './wallet.entity';

/**
 * Porta de persistência da Wallet (independente de ORM/infra).
 */
export interface WalletRepository {
  save(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | null>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
