import { ApplicationError } from '../../shared/application.error';

export class InvalidReconcileWalletInputError extends ApplicationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReconcileWalletInputError';
  }
}
