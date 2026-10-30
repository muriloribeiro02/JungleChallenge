import { ApplicationError } from '../../shared/application.error';

export class InvalidSubmitWagerInputError extends ApplicationError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSubmitWagerInputError';
  }
}

export class UnsupportedWagerKindError extends ApplicationError {
  constructor(kind: string) {
    super(`kind não suportado pela API: ${kind}`);
    this.name = 'UnsupportedWagerKindError';
  }
}
