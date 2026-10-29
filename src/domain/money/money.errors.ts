import { DomainError } from '../shared/domain.error';

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {}
