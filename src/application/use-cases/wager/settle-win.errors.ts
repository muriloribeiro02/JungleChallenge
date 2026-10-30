import { ApplicationError } from '../../shared/application.error';

export class InvalidSettleWinInputError extends ApplicationError {}

export class WalletNotFoundForWinError extends ApplicationError {
  constructor(walletId: string) {
    super(`Carteira não encontrada para WIN: ${walletId}`);
  }
}

export class WalletPlayerMismatchForWinError extends ApplicationError {
  constructor() {
    super('A carteira não pertence ao player informado');
  }
}

export class WalletCurrencyMismatchForWinError extends ApplicationError {
  constructor() {
    super('A moeda da operação não corresponde à moeda da carteira');
  }
}

export class IdempotencyPayloadConflictForWinError extends ApplicationError {
  constructor(providerId: string, idempotencyKey: string) {
    super(
      `Conflito de payload para providerId=${providerId} idempotencyKey=${idempotencyKey}`,
    );
  }
}

export class ExternalTransactionConflictForWinError extends ApplicationError {
  constructor(providerId: string, externalTransactionId: string) {
    super(
      `Conflito de externalTransactionId para providerId=${providerId} externalTransactionId=${externalTransactionId}`,
    );
  }
}

export class TerminalWinSnapshotMissingError extends ApplicationError {
  constructor(transactionId: string) {
    super(
      `Replay impossível: transação terminal ${transactionId} sem observed_balance/observed_wallet_version`,
    );
  }
}
