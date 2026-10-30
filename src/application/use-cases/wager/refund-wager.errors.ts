import { ApplicationError } from '../../shared/application.error';

export class InvalidRefundWagerInputError extends ApplicationError {}

export class WalletNotFoundForRefundError extends ApplicationError {
  constructor(walletId: string) {
    super(`Carteira não encontrada para REFUND: ${walletId}`);
  }
}

export class WalletPlayerMismatchForRefundError extends ApplicationError {
  constructor() {
    super('A carteira não pertence ao player informado');
  }
}

export class WalletCurrencyMismatchForRefundError extends ApplicationError {
  constructor() {
    super('A moeda da operação não corresponde à moeda da carteira');
  }
}

export class IdempotencyPayloadConflictForRefundError extends ApplicationError {
  constructor(providerId: string, idempotencyKey: string) {
    super(
      `Conflito de payload para providerId=${providerId} idempotencyKey=${idempotencyKey}`,
    );
  }
}

export class ExternalTransactionConflictForRefundError extends ApplicationError {
  constructor(providerId: string, externalTransactionId: string) {
    super(
      `Conflito de externalTransactionId para providerId=${providerId} externalTransactionId=${externalTransactionId}`,
    );
  }
}

export class TerminalRefundSnapshotMissingError extends ApplicationError {
  constructor(transactionId: string) {
    super(
      `Replay impossível: transação terminal ${transactionId} sem observed_balance/observed_wallet_version`,
    );
  }
}
