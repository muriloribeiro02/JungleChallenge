import { ApplicationError } from '../../shared/application.error';

export class WalletNotFoundError extends ApplicationError {
  constructor(walletId: string) {
    super(`Carteira não encontrada: ${walletId}`);
  }
}
