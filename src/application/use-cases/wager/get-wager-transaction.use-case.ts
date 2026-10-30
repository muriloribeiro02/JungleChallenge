import type { UnitOfWork } from '../../ports/unit-of-work';
import {
  InvalidGetWagerTransactionInputError,
  WagerTransactionNotFoundError,
} from './get-wager-transaction.errors';

export type GetWagerTransactionByIdInput = {
  transactionId: string;
};

export type GetWagerTransactionByExternalInput = {
  providerId: string;
  externalTransactionId: string;
};

export type GetWagerTransactionOutput = {
  transactionId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  status: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId: string | null;
  failureCode: string | null;
  observedBalance: string | null;
  walletVersion: number | null;
  createdAt: string;
  processedAt: string | null;
};

export class GetWagerTransactionUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async byId(
    input: GetWagerTransactionByIdInput,
  ): Promise<GetWagerTransactionOutput> {
    if (
      typeof input.transactionId !== 'string' ||
      input.transactionId.trim() === ''
    ) {
      throw new InvalidGetWagerTransactionInputError(
        'transactionId é obrigatório',
      );
    }

    return this.unitOfWork.run(async (repos) => {
      const tx = await repos.wagerTransactions.findById(input.transactionId);
      if (!tx) {
        throw new WagerTransactionNotFoundError(input.transactionId);
      }
      return toOutput(tx);
    });
  }

  async byProviderExternal(
    input: GetWagerTransactionByExternalInput,
  ): Promise<GetWagerTransactionOutput> {
    if (typeof input.providerId !== 'string' || input.providerId.trim() === '') {
      throw new InvalidGetWagerTransactionInputError('providerId é obrigatório');
    }
    if (
      typeof input.externalTransactionId !== 'string' ||
      input.externalTransactionId.trim() === ''
    ) {
      throw new InvalidGetWagerTransactionInputError(
        'externalTransactionId é obrigatório',
      );
    }

    return this.unitOfWork.run(async (repos) => {
      const tx =
        await repos.wagerTransactions.findByProviderIdAndExternalTransactionId(
          input.providerId,
          input.externalTransactionId,
        );
      if (!tx) {
        throw new WagerTransactionNotFoundError(
          `${input.providerId}:${input.externalTransactionId}`,
        );
      }
      return toOutput(tx);
    });
  }
}

function toOutput(tx: {
  id: string;
  providerId: string | null;
  externalTransactionId: string | null;
  walletId: string;
  playerId: string | null;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  status: string;
  amount: { toJSON(): { amount: string; currency: string } };
  externalReference: string | null;
  failureCode: string | null;
  observedBalance: { toString(): string } | null;
  observedWalletVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}): GetWagerTransactionOutput {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId ?? '',
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    money: tx.amount.toJSON(),
    referenceExternalTransactionId: tx.externalReference,
    failureCode: tx.failureCode,
    observedBalance: tx.observedBalance
      ? tx.observedBalance.toString()
      : null,
    walletVersion: tx.observedWalletVersion,
    createdAt: tx.createdAt.toISOString(),
    processedAt:
      tx.status === 'PROCESSED' || tx.status === 'REJECTED'
        ? tx.updatedAt.toISOString()
        : null,
  };
}
