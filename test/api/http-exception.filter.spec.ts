import { HttpStatus } from '@nestjs/common';
import { mapHttpError } from '../../src/api/http/filters/http-exception.filter';
import { ApplicationError } from '../../src/application/shared/application.error';
import { WalletNotFoundError } from '../../src/application/use-cases/wallet/get-wallet-balance.errors';
import { InvalidOpenWalletInputError } from '../../src/application/use-cases/wallet/open-wallet.errors';
import {
  ExternalTransactionConflictError,
  WalletNotFoundForBetError,
} from '../../src/application/use-cases/wager/place-bet.errors';
import {
  ExternalTransactionConflictForRefundError,
  WalletNotFoundForRefundError,
} from '../../src/application/use-cases/wager/refund-wager.errors';
import {
  ExternalTransactionConflictForRollbackError,
  WalletNotFoundForRollbackError,
} from '../../src/application/use-cases/wager/rollback-wager.errors';
import {
  ExternalTransactionConflictForWinError,
} from '../../src/application/use-cases/wager/settle-win.errors';
import {
  ExternalTransactionConflictForLossError,
} from '../../src/application/use-cases/wager/settle-loss.errors';
import { WalletAlreadyExistsError } from '../../src/domain/wallet/wallet.errors';

class UnmappedApplicationError extends ApplicationError {
  constructor() {
    super('erro de aplicação sem mapa explícito');
  }
}

describe('mapHttpError (GlobalHttpExceptionFilter)', () => {
  describe('404 — wallet / recurso inexistente', () => {
    it.each([
      ['WalletNotFoundError', new WalletNotFoundError('w1')],
      ['WalletNotFoundForBetError', new WalletNotFoundForBetError('w1')],
      ['WalletNotFoundForRefundError', new WalletNotFoundForRefundError('w1')],
      [
        'WalletNotFoundForRollbackError',
        new WalletNotFoundForRollbackError('w1'),
      ],
    ] as const)('%s → 404', (_label, error) => {
      const mapped = mapHttpError(error);
      expect(mapped.status).toBe(HttpStatus.NOT_FOUND);
      expect(mapped.code).toBe(error.name);
      expect(mapped.message).toBe(error.message);
    });
  });

  describe('409 — conflitos', () => {
    it.each([
      ['WalletAlreadyExistsError', new WalletAlreadyExistsError('p', 'BRL')],
      [
        'ExternalTransactionConflictError',
        new ExternalTransactionConflictError('p', 'e'),
      ],
      [
        'ExternalTransactionConflictForWinError',
        new ExternalTransactionConflictForWinError('p', 'e'),
      ],
      [
        'ExternalTransactionConflictForLossError',
        new ExternalTransactionConflictForLossError('p', 'e'),
      ],
      [
        'ExternalTransactionConflictForRefundError',
        new ExternalTransactionConflictForRefundError('p', 'e'),
      ],
      [
        'ExternalTransactionConflictForRollbackError',
        new ExternalTransactionConflictForRollbackError('p', 'e'),
      ],
    ] as const)('%s → 409', (_label, error) => {
      const mapped = mapHttpError(error);
      expect(mapped.status).toBe(HttpStatus.CONFLICT);
      expect(mapped.code).toBe(error.name);
      expect(mapped.message).toBe(error.message);
    });
  });

  describe('regressão e fallback', () => {
    it('InvalidOpenWalletInputError → 400', () => {
      const error = new InvalidOpenWalletInputError('input inválido');
      expect(mapHttpError(error)).toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        code: 'InvalidOpenWalletInputError',
      });
    });

    it('ApplicationError sem mapa explícito → 400 (não 404/409 genérico)', () => {
      const error = new UnmappedApplicationError();
      expect(mapHttpError(error)).toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        code: 'UnmappedApplicationError',
      });
    });

    it('erro desconhecido → 500', () => {
      expect(mapHttpError(new Error('boom'))).toEqual({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message: 'Erro interno',
      });
    });
  });
});
