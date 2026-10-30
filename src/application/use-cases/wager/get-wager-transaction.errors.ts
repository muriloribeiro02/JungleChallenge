import { ApplicationError } from '../../shared/application.error';

export class InvalidGetWagerTransactionInputError extends ApplicationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGetWagerTransactionInputError';
  }
}

export class WagerTransactionNotFoundError extends ApplicationError {
  constructor(id: string) {
    super(`Transação não encontrada: ${id}`);
    this.name = 'WagerTransactionNotFoundError';
  }
}
