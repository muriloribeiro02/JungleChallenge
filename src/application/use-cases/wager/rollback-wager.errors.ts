import { ApplicationError } from '../../shared/application.error';

export class InvalidRollbackWagerInputError extends ApplicationError {}

export class WalletNotFoundForRollbackError extends ApplicationError {
  constructor(walletId: string) {
    super(`Carteira não encontrada para ROLLBACK: ${walletId}`);
  }
}

export class WalletPlayerMismatchForRollbackError extends ApplicationError {
  constructor() {
    super('A carteira não pertence ao player informado');
  }
}

export class WalletCurrencyMismatchForRollbackError extends ApplicationError {
  constructor() {
    super('A moeda da operação não corresponde à moeda da carteira');
  }
}

export class IdempotencyPayloadConflictForRollbackError extends ApplicationError {
  constructor(providerId: string, idempotencyKey: string) {
    super(
      `Conflito de payload para providerId=${providerId} idempotencyKey=${idempotencyKey}`,
    );
  }
}

export class ExternalTransactionConflictForRollbackError extends ApplicationError {
  constructor(providerId: string, externalTransactionId: string) {
    super(
      `Conflito de externalTransactionId para providerId=${providerId} externalTransactionId=${externalTransactionId}`,
    );
  }
}

export class TerminalRollbackSnapshotMissingError extends ApplicationError {
  constructor(transactionId: string) {
    super(
      `Replay impossível: transação terminal ${transactionId} sem observed_balance/observed_wallet_version`,
    );
  }
}
