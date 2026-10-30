import { ApplicationError } from '../../shared/application.error';

export class InvalidListWalletLedgerInputError extends ApplicationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidListWalletLedgerInputError';
  }
}
