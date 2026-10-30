import type { UnitOfWork } from '../../ports/unit-of-work';
import type { PlaceBetUseCase } from './place-bet.use-case';
import type { RefundWagerUseCase } from './refund-wager.use-case';
import type { RollbackWagerUseCase } from './rollback-wager.use-case';
import type { SettleLossUseCase } from './settle-loss.use-case';
import type { SettleWinUseCase } from './settle-win.use-case';
import {
  InvalidSubmitWagerInputError,
  UnsupportedWagerKindError,
} from './submit-wager-transaction.errors';

export type SubmitWagerTransactionInput = {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  idempotencyKey: string;
};

export type SubmitWagerTransactionOutput = {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string } | null;
  failureCode?: string;
  idempotentReplay: boolean;
};

/**
 * Fachada HTTP → use cases existentes por kind.
 * Decide idempotentReplay consultando a chave antes da execução.
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly placeBet: PlaceBetUseCase,
    private readonly settleWin: SettleWinUseCase,
    private readonly settleLoss: SettleLossUseCase,
    private readonly refundWager: RefundWagerUseCase,
    private readonly rollbackWager: RollbackWagerUseCase,
  ) {}

  async execute(
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionOutput> {
    this.assertInput(input);

    const prior = await this.unitOfWork.run((repos) =>
      repos.wagerTransactions.findByProviderIdAndIdempotencyKey(
        input.providerId,
        input.idempotencyKey,
      ),
    );
    const idempotentReplay = prior !== null;

    switch (input.kind) {
      case 'BET': {
        const result = await this.placeBet.execute({
          providerId: input.providerId,
          playerId: input.playerId,
          walletId: input.walletId,
          amount: input.money.amount,
          currency: input.money.currency,
          roundId: input.roundId,
          gameId: input.gameId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
        });
        return {
          transactionId: result.transactionId,
          status: result.status,
          balance: {
            amount: result.observedBalance,
            currency: result.currency,
          },
          failureCode: result.failureCode,
          idempotentReplay,
        };
      }
      case 'WIN': {
        const result = await this.settleWin.execute({
          providerId: input.providerId,
          playerId: input.playerId,
          walletId: input.walletId,
          amount: input.money.amount,
          currency: input.money.currency,
          roundId: input.roundId,
          gameId: input.gameId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
        });
        return {
          transactionId: result.transactionId,
          status: result.status,
          balance: {
            amount: result.observedBalance,
            currency: result.currency,
          },
          idempotentReplay,
        };
      }
      case 'LOSS': {
        const result = await this.settleLoss.execute({
          providerId: input.providerId,
          playerId: input.playerId,
          walletId: input.walletId,
          amount: input.money.amount,
          currency: input.money.currency,
          roundId: input.roundId,
          gameId: input.gameId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
        });
        return {
          transactionId: result.transactionId,
          status: result.status,
          balance: {
            amount: result.observedBalance,
            currency: result.currency,
          },
          idempotentReplay,
        };
      }
      case 'REFUND': {
        if (!input.referenceExternalTransactionId) {
          throw new InvalidSubmitWagerInputError(
            'referenceExternalTransactionId é obrigatório para REFUND',
          );
        }
        const result = await this.refundWager.execute({
          providerId: input.providerId,
          playerId: input.playerId,
          walletId: input.walletId,
          amount: input.money.amount,
          currency: input.money.currency,
          roundId: input.roundId,
          gameId: input.gameId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
        });
        return {
          transactionId: result.transactionId,
          status: result.status,
          balance:
            result.observedBalance !== undefined
              ? {
                  amount: result.observedBalance,
                  currency: result.currency,
                }
              : null,
          failureCode: result.failureCode,
          idempotentReplay,
        };
      }
      case 'ROLLBACK': {
        if (!input.referenceExternalTransactionId) {
          throw new InvalidSubmitWagerInputError(
            'referenceExternalTransactionId é obrigatório para ROLLBACK',
          );
        }
        const result = await this.rollbackWager.execute({
          providerId: input.providerId,
          playerId: input.playerId,
          walletId: input.walletId,
          amount: input.money.amount,
          currency: input.money.currency,
          roundId: input.roundId,
          gameId: input.gameId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
        });
        return {
          transactionId: result.transactionId,
          status: result.status,
          balance:
            result.observedBalance !== undefined
              ? {
                  amount: result.observedBalance,
                  currency: result.currency,
                }
              : null,
          failureCode: result.failureCode,
          idempotentReplay,
        };
      }
      default:
        throw new UnsupportedWagerKindError(String(input.kind));
    }
  }

  private assertInput(input: SubmitWagerTransactionInput): void {
    const required = [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'kind',
      'idempotencyKey',
    ] as const;
    for (const key of required) {
      if (typeof input[key] !== 'string' || input[key].trim() === '') {
        throw new InvalidSubmitWagerInputError(`${key} é obrigatório`);
      }
    }
    if (!input.money || typeof input.money.amount !== 'string') {
      throw new InvalidSubmitWagerInputError('money.amount é obrigatório');
    }
    if (typeof input.money.currency !== 'string') {
      throw new InvalidSubmitWagerInputError('money.currency é obrigatório');
    }
  }
}
