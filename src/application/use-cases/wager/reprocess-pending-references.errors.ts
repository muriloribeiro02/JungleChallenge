import { ApplicationError } from '../../shared/application.error';

export class InvalidReprocessPendingInputError extends ApplicationError {}

export class PendingTransactionNotFoundError extends ApplicationError {
  constructor(transactionId: string) {
    super(`Transação pendente não encontrada: ${transactionId}`);
  }
}

export class WalletNotFoundForReprocessError extends ApplicationError {
  constructor(walletId: string) {
    super(`Carteira não encontrada no reprocessamento: ${walletId}`);
  }
}
