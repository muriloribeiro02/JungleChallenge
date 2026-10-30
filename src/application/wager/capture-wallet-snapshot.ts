import type { Wallet } from '../../domain/wallet/wallet.entity';
import type { OperationResultSnapshot } from '../../domain/wager-transaction/operation-result-snapshot';

/**
 * Captura saldo e versão observados da carteira em memória.
 * Não acessa banco — o caller deve ter a wallet já carregada (ex.: sob FOR UPDATE).
 */
export function captureWalletSnapshot(wallet: Wallet): OperationResultSnapshot {
  return {
    observedBalance: wallet.balance,
    observedWalletVersion: wallet.version,
  };
}
