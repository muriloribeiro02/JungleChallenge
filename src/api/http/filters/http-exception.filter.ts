import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError } from '../../../application/shared/application.error';
import { DomainError } from '../../../domain/shared/domain.error';
import { WalletAlreadyExistsError } from '../../../domain/wallet/wallet.errors';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  ReferenceAlreadyReversedConflictError,
} from '../../../domain/wager-transaction/wager-transaction.errors';
import { WalletNotFoundError } from '../../../application/use-cases/wallet/get-wallet-balance.errors';
import { WagerTransactionNotFoundError } from '../../../application/use-cases/wager/get-wager-transaction.errors';
import {
  ExternalTransactionConflictError,
  IdempotencyPayloadConflictError,
  InvalidPlaceBetInputError,
  WalletCurrencyMismatchForBetError,
  WalletNotFoundForBetError,
  WalletPlayerMismatchError,
} from '../../../application/use-cases/wager/place-bet.errors';
import {
  ExternalTransactionConflictForRefundError,
  IdempotencyPayloadConflictForRefundError,
  WalletNotFoundForRefundError,
} from '../../../application/use-cases/wager/refund-wager.errors';
import {
  ExternalTransactionConflictForRollbackError,
  IdempotencyPayloadConflictForRollbackError,
  WalletNotFoundForRollbackError,
} from '../../../application/use-cases/wager/rollback-wager.errors';
import {
  ExternalTransactionConflictForWinError,
  IdempotencyPayloadConflictForWinError,
  InvalidSettleWinInputError,
  WalletNotFoundForWinError,
} from '../../../application/use-cases/wager/settle-win.errors';
import {
  ExternalTransactionConflictForLossError,
  IdempotencyPayloadConflictForLossError,
  InvalidSettleLossInputError,
  WalletNotFoundForLossError,
} from '../../../application/use-cases/wager/settle-loss.errors';
import { InvalidSubmitWagerInputError } from '../../../application/use-cases/wager/submit-wager-transaction.errors';
import { InvalidOpenWalletInputError } from '../../../application/use-cases/wallet/open-wallet.errors';
import { InvalidListWalletLedgerInputError } from '../../../application/use-cases/wallet/list-wallet-ledger.errors';
import { InvalidReconcileWalletInputError } from '../../../application/use-cases/wallet/reconcile-wallet.errors';
import { InvalidMoneyError } from '../../../domain/money/money.errors';

type ErrorConstructor = abstract new (...args: never[]) => Error;

const CONFLICT_ERRORS: readonly ErrorConstructor[] = [
  WalletAlreadyExistsError,
  IdempotencyKeyConflictError,
  IdempotencyPayloadConflictError,
  IdempotencyPayloadConflictForWinError,
  IdempotencyPayloadConflictForLossError,
  IdempotencyPayloadConflictForRefundError,
  IdempotencyPayloadConflictForRollbackError,
  ExternalTransactionIdConflictError,
  ExternalTransactionConflictError,
  ExternalTransactionConflictForWinError,
  ExternalTransactionConflictForLossError,
  ExternalTransactionConflictForRefundError,
  ExternalTransactionConflictForRollbackError,
  ReferenceAlreadyReversedConflictError,
];

const NOT_FOUND_ERRORS: readonly ErrorConstructor[] = [
  WalletNotFoundError,
  WalletNotFoundForBetError,
  WalletNotFoundForWinError,
  WalletNotFoundForLossError,
  WalletNotFoundForRefundError,
  WalletNotFoundForRollbackError,
  WagerTransactionNotFoundError,
];

const BAD_REQUEST_ERRORS: readonly ErrorConstructor[] = [
  InvalidOpenWalletInputError,
  InvalidPlaceBetInputError,
  InvalidSettleWinInputError,
  InvalidSettleLossInputError,
  InvalidSubmitWagerInputError,
  InvalidListWalletLedgerInputError,
  InvalidReconcileWalletInputError,
  InvalidMoneyError,
  WalletCurrencyMismatchForBetError,
  WalletPlayerMismatchError,
];

/**
 * Mapeamento HTTP (decisão de implementação — contrato exige distinção clara):
 * - 400: payload/validação inválidos
 * - 404: recurso inexistente
 * - 409: conflito (wallet duplicada, idempotência divergente, unique)
 * - 503: falha transitória de infraestrutura
 * - 500: erro inesperado (sem stack/SQL na resposta)
 *
 * Rejeições de negócio (INSUFFICIENT_FUNDS etc.) retornam 200/202 no controller
 * com status no body — não passam por este filtro.
 */
@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalHttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(
        typeof body === 'string'
          ? { statusCode: status, error: 'HTTP_ERROR', message: body }
          : body,
      );
      return;
    }

    const mapped = mapHttpError(exception);
    if (mapped.status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
      );
    }

    response.status(mapped.status).json({
      statusCode: mapped.status,
      error: mapped.code,
      message: mapped.message,
    });
  }
}

function isOneOf(
  exception: unknown,
  constructors: readonly ErrorConstructor[],
): exception is Error {
  return constructors.some((Ctor) => exception instanceof Ctor);
}

/** Exportado para testes unitários do mapeamento. */
export function mapHttpError(exception: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (isOneOf(exception, CONFLICT_ERRORS)) {
    return {
      status: HttpStatus.CONFLICT,
      code: exception.name,
      message: exception.message,
    };
  }

  if (isOneOf(exception, NOT_FOUND_ERRORS)) {
    return {
      status: HttpStatus.NOT_FOUND,
      code: exception.name,
      message: exception.message,
    };
  }

  if (isOneOf(exception, BAD_REQUEST_ERRORS)) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: exception.name,
      message: exception.message,
    };
  }

  if (exception instanceof ApplicationError || exception instanceof DomainError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: exception.name,
      message: exception.message,
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    message: 'Erro interno',
  };
}
