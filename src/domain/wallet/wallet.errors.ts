import { DomainError } from '../shared/domain.error';

export class InvalidWalletError extends DomainError {}

export class WalletCurrencyMismatchError extends DomainError {}
