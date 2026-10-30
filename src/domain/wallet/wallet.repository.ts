import type { Wallet } from './wallet.entity';

/**
 * Porta de persistência da Wallet (independente de ORM/infra).
 */
export interface WalletRepository {
  save(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | null>;
  /**
   * Carrega a carteira com bloqueio pessimista (SELECT … FOR UPDATE).
   * Deve ser chamado apenas dentro de uma transação do UnitOfWork.
   */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerIdAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
