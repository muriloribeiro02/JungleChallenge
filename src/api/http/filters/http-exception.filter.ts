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
import { IdempotencyPayloadConflictForRefundError } from '../../../application/use-cases/wager/refund-wager.errors';
import { IdempotencyPayloadConflictForRollbackError } from '../../../application/use-cases/wager/rollback-wager.errors';
import {
  IdempotencyPayloadConflictForWinError,
  InvalidSettleWinInputError,
  WalletNotFoundForWinError,
} from '../../../application/use-cases/wager/settle-win.errors';
import {
  IdempotencyPayloadConflictForLossError,
  InvalidSettleLossInputError,
  WalletNotFoundForLossError,
} from '../../../application/use-cases/wager/settle-loss.errors';
import { InvalidSubmitWagerInputError } from '../../../application/use-cases/wager/submit-wager-transaction.errors';
import { InvalidOpenWalletInputError } from '../../../application/use-cases/wallet/open-wallet.errors';
import { InvalidListWalletLedgerInputError } from '../../../application/use-cases/wallet/list-wallet-ledger.errors';
import { InvalidReconcileWalletInputError } from '../../../application/use-cases/wallet/reconcile-wallet.errors';
import { InvalidMoneyError } from '../../../domain/money/money.errors';

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

    const mapped = mapError(exception);
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

function mapError(exception: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (
    exception instanceof WalletAlreadyExistsError ||
    exception instanceof IdempotencyKeyConflictError ||
    exception instanceof IdempotencyPayloadConflictError ||
    exception instanceof IdempotencyPayloadConflictForWinError ||
    exception instanceof IdempotencyPayloadConflictForLossError ||
    exception instanceof IdempotencyPayloadConflictForRefundError ||
    exception instanceof IdempotencyPayloadConflictForRollbackError ||
    exception instanceof ExternalTransactionIdConflictError ||
    exception instanceof ExternalTransactionConflictError ||
    exception instanceof ReferenceAlreadyReversedConflictError
  ) {
    return {
      status: HttpStatus.CONFLICT,
      code: exception.name,
      message: exception.message,
    };
  }

  if (
    exception instanceof WalletNotFoundError ||
    exception instanceof WalletNotFoundForBetError ||
    exception instanceof WalletNotFoundForWinError ||
    exception instanceof WalletNotFoundForLossError ||
    exception instanceof WagerTransactionNotFoundError
  ) {
    return {
      status: HttpStatus.NOT_FOUND,
      code: exception.name,
      message: exception.message,
    };
  }

  if (
    exception instanceof InvalidOpenWalletInputError ||
    exception instanceof InvalidPlaceBetInputError ||
    exception instanceof InvalidSettleWinInputError ||
    exception instanceof InvalidSettleLossInputError ||
    exception instanceof InvalidSubmitWagerInputError ||
    exception instanceof InvalidListWalletLedgerInputError ||
    exception instanceof InvalidReconcileWalletInputError ||
    exception instanceof InvalidMoneyError ||
    exception instanceof WalletCurrencyMismatchForBetError ||
    exception instanceof WalletPlayerMismatchError
  ) {
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
