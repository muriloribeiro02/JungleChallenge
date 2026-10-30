import { ApplicationError } from '../../shared/application.error';

export class InvalidSettleLossInputError extends ApplicationError {}

export class WalletNotFoundForLossError extends ApplicationError {
  constructor(walletId: string) {
    super(`Carteira não encontrada para LOSS: ${walletId}`);
  }
}

export class WalletPlayerMismatchForLossError extends ApplicationError {
  constructor() {
    super('A carteira não pertence ao player informado');
  }
}

export class WalletCurrencyMismatchForLossError extends ApplicationError {
  constructor() {
    super('A moeda da operação não corresponde à moeda da carteira');
  }
}

export class IdempotencyPayloadConflictForLossError extends ApplicationError {
  constructor(providerId: string, idempotencyKey: string) {
    super(
      `Conflito de payload para providerId=${providerId} idempotencyKey=${idempotencyKey}`,
    );
  }
}

export class ExternalTransactionConflictForLossError extends ApplicationError {
  constructor(providerId: string, externalTransactionId: string) {
    super(
      `Conflito de externalTransactionId para providerId=${providerId} externalTransactionId=${externalTransactionId}`,
    );
  }
}

export class TerminalLossSnapshotMissingError extends ApplicationError {
  constructor(transactionId: string) {
    super(
      `Replay impossível: transação terminal ${transactionId} sem observed_balance/observed_wallet_version`,
    );
  }
}
