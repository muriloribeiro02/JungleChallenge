import { DomainError } from '../shared/domain.error';

export class InvalidWalletError extends DomainError {}

export class WalletCurrencyMismatchError extends DomainError {}

export class WalletAlreadyExistsError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(
      `Já existe carteira para playerId=${playerId} e currency=${currency}`,
    );
  }
}
