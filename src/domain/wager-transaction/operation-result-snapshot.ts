import type { Money } from '../money/money';

/**
 * Snapshot durável do resultado no momento do processamento.
 * Usado para replay idempotente sem depender de outbox/ledger/saldo atual.
 */
export type OperationResultSnapshot = {
  observedBalance: Money;
  observedWalletVersion: number;
};
