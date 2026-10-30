import { ApplicationError } from '../../shared/application.error';

export class InvalidPlaceBetInputError extends ApplicationError {}

export class WalletNotFoundForBetError extends ApplicationError {
  constructor(walletId: string) {
    super(`Carteira não encontrada para aposta: ${walletId}`);
  }
}

export class WalletPlayerMismatchError extends ApplicationError {
  constructor() {
    super('A carteira não pertence ao player informado');
  }
}

export class WalletCurrencyMismatchForBetError extends ApplicationError {
  constructor() {
    super('A moeda da operação não corresponde à moeda da carteira');
  }
}

export class IdempotencyPayloadConflictError extends ApplicationError {
  constructor(providerId: string, idempotencyKey: string) {
    super(
      `Conflito de payload para providerId=${providerId} idempotencyKey=${idempotencyKey}`,
    );
  }
}

export class ExternalTransactionConflictError extends ApplicationError {
  constructor(providerId: string, externalTransactionId: string) {
    super(
      `Conflito de externalTransactionId para providerId=${providerId} externalTransactionId=${externalTransactionId}`,
    );
  }
}
