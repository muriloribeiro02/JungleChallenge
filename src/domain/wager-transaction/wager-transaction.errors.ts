import { DomainError } from '../shared/domain.error';

export class InvalidWagerTransactionError extends DomainError {}

/** Violação UNIQUE de idempotência — a transação SQL atual foi abortada pelo Postgres. */
export class IdempotencyKeyConflictError extends DomainError {
  constructor() {
    super('Violação de unicidade em provider_id+idempotency_key');
  }
}

/** Violação UNIQUE de id externo do provedor — não deve ser tratada como replay. */
export class ExternalTransactionIdConflictError extends DomainError {
  constructor() {
    super('Violação de unicidade em provider_id+external_transaction_id');
  }
}

/** Violação UNIQUE: já existe REFUND/ROLLBACK PROCESSED para a mesma referência. */
export class ReferenceAlreadyReversedConflictError extends DomainError {
  constructor() {
    super(
      'Violação de unicidade: referência já revertida por REFUND ou ROLLBACK processado',
    );
  }
}
