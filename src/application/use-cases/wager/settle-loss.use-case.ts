import { randomUUID } from 'node:crypto';
import { Money } from '../../../domain/money/money';
import { OutboxMessage as OutboxMessageEntity } from '../../../domain/outbox/outbox-message.entity';
import type { Wallet } from '../../../domain/wallet/wallet.entity';
import {
  WagerTransaction,
  WAGER_TRANSACTION_STATUS_PROCESSED,
} from '../../../domain/wager-transaction/wager-transaction.entity';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
} from '../../../domain/wager-transaction/wager-transaction.errors';
import { buildWagerTransactionProcessedEvent } from '../../events/wallet-balance.events';
import type { UnitOfWork } from '../../ports/unit-of-work';
import { captureWalletSnapshot } from '../../wager/capture-wallet-snapshot';
import {
  computeLossPayloadHash,
  type LossBusinessPayload,
} from '../../wager/canonical-payload-hash';
import {
  ExternalTransactionConflictForLossError,
  IdempotencyPayloadConflictForLossError,
  InvalidSettleLossInputError,
  TerminalLossSnapshotMissingError,
  WalletCurrencyMismatchForLossError,
  WalletNotFoundForLossError,
  WalletPlayerMismatchForLossError,
} from './settle-loss.errors';

export type SettleLossInput = {
  providerId: string;
  playerId: string;
  walletId: string;
  /** Deve ser "0.00" (ou equivalente zero); Money.zero é usado internamente. */
  amount: string;
  currency: string;
  roundId: string;
  gameId: string;
  externalTransactionId: string;
  idempotencyKey: string;
};

export type SettleLossOutput = {
  transactionId: string;
  walletId: string;
  status: 'PROCESSED';
  amount: string;
  currency: string;
  observedBalance: string;
  walletVersion: number;
};

/**
 * SettleLossUseCase — registra resultado sem movimento financeiro.
 * Amount canônico "0.00" via Money.zero. Lock serializa com BET/WIN.
 * Sem ledger; só WagerTransactionProcessed. Replay via snapshot.
 */
export class SettleLossUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(input: SettleLossInput): Promise<SettleLossOutput> {
    this.assertInput(input);

    const amount = Money.zero(input.currency);
    const provided = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!provided.isZero()) {
      throw new InvalidSettleLossInputError('amount da LOSS deve ser zero');
    }

    const businessPayload: LossBusinessPayload = {
      providerId: input.providerId,
      playerId: input.playerId,
      walletId: input.walletId,
      amount: amount.toString(),
      currency: amount.currency,
      roundId: input.roundId,
      gameId: input.gameId,
      externalTransactionId: input.externalTransactionId,
      kind: 'LOSS',
    };
    const payloadHash = computeLossPayloadHash(businessPayload);

    try {
      return await this.unitOfWork.run((repos) =>
        this.processLoss(repos, input, amount, payloadHash),
      );
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError) {
        return this.unitOfWork.run((repos) =>
          this.replayOrConflict(
            repos,
            input.providerId,
            input.idempotencyKey,
            payloadHash,
          ),
        );
      }
      if (error instanceof ExternalTransactionIdConflictError) {
        throw new ExternalTransactionConflictForLossError(
          input.providerId,
          input.externalTransactionId,
        );
      }
      throw error;
    }
  }

  private async processLoss(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    input: SettleLossInput,
    amount: Money,
    payloadHash: string,
  ): Promise<SettleLossOutput> {
    const existing =
      await repos.wagerTransactions.findByProviderIdAndIdempotencyKey(
        input.providerId,
        input.idempotencyKey,
      );

    if (existing) {
      return this.buildReplayFromExisting(
        existing,
        payloadHash,
        input.providerId,
        input.idempotencyKey,
      );
    }

    const wallet = await repos.wallets.findByIdForUpdate(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundForLossError(input.walletId);
    }

    if (wallet.playerId !== input.playerId) {
      throw new WalletPlayerMismatchForLossError();
    }

    if (wallet.currency !== amount.currency) {
      throw new WalletCurrencyMismatchForLossError();
    }

    const again =
      await repos.wagerTransactions.findByProviderIdAndIdempotencyKey(
        input.providerId,
        input.idempotencyKey,
      );
    if (again) {
      return this.buildReplayFromExisting(
        again,
        payloadHash,
        input.providerId,
        input.idempotencyKey,
      );
    }

    return this.persistProcessed(repos, wallet, amount, input, payloadHash);
  }

  private async persistProcessed(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    wallet: Wallet,
    amount: Money,
    input: SettleLossInput,
    payloadHash: string,
  ): Promise<SettleLossOutput> {
    const snapshot = captureWalletSnapshot(wallet);

    const transaction = WagerTransaction.lossProcessed({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: input.playerId,
      amount,
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      roundId: input.roundId,
      gameId: input.gameId,
      snapshot,
    });

    const processedEvent = buildWagerTransactionProcessedEvent({
      transaction,
      observedBalance: snapshot.observedBalance.toString(),
      correlationId: input.idempotencyKey,
    });

    await repos.wagerTransactions.save(transaction);
    await repos.outboxMessages.save(
      OutboxMessageEntity.fromEnvelope(processedEvent),
    );

    return {
      transactionId: transaction.id,
      walletId: wallet.id,
      status: WAGER_TRANSACTION_STATUS_PROCESSED,
      amount: amount.toString(),
      currency: amount.currency,
      observedBalance: snapshot.observedBalance.toString(),
      walletVersion: snapshot.observedWalletVersion,
    };
  }

  private async replayOrConflict(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    providerId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<SettleLossOutput> {
    const existing =
      await repos.wagerTransactions.findByProviderIdAndIdempotencyKey(
        providerId,
        idempotencyKey,
      );

    if (!existing) {
      throw new InvalidSettleLossInputError(
        'Violação de unicidade sem registro idempotente legível',
      );
    }

    return this.buildReplayFromExisting(
      existing,
      payloadHash,
      providerId,
      idempotencyKey,
    );
  }

  private buildReplayFromExisting(
    existing: WagerTransaction,
    payloadHash: string,
    providerId: string,
    idempotencyKey: string,
  ): SettleLossOutput {
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyPayloadConflictForLossError(
        providerId,
        idempotencyKey,
      );
    }

    if (
      existing.observedBalance === null ||
      existing.observedWalletVersion === null
    ) {
      throw new TerminalLossSnapshotMissingError(existing.id);
    }

    return {
      transactionId: existing.id,
      walletId: existing.walletId,
      status: WAGER_TRANSACTION_STATUS_PROCESSED,
      amount: existing.amount.toString(),
      currency: existing.amount.currency,
      observedBalance: existing.observedBalance.toString(),
      walletVersion: existing.observedWalletVersion,
    };
  }

  private assertInput(input: SettleLossInput): void {
    const required: Array<keyof SettleLossInput> = [
      'providerId',
      'playerId',
      'walletId',
      'amount',
      'currency',
      'roundId',
      'gameId',
      'externalTransactionId',
      'idempotencyKey',
    ];

    for (const field of required) {
      const value = input[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidSettleLossInputError(`${field} é obrigatório`);
      }
    }
  }
}
