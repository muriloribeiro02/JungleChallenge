import { randomUUID } from 'node:crypto';
import { Money } from '../../../domain/money/money';
import { OutboxMessage as OutboxMessageEntity } from '../../../domain/outbox/outbox-message.entity';
import type { Wallet } from '../../../domain/wallet/wallet.entity';
import {
  WagerTransaction,
  WAGER_TRANSACTION_STATUS_PROCESSED,
} from '../../../domain/wager-transaction/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger/wallet-ledger-entry.entity';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
} from '../../../domain/wager-transaction/wager-transaction.errors';
import {
  buildWagerTransactionProcessedEvent,
  buildWalletBalanceChangedEvent,
} from '../../events/wallet-opening.events';
import type { UnitOfWork } from '../../unit-of-work/unit-of-work';
import { captureWalletSnapshot } from '../../wager/capture-wallet-snapshot';
import {
  computeWinPayloadHash,
  type WinBusinessPayload,
} from '../../wager/canonical-payload-hash';
import {
  ExternalTransactionConflictForWinError,
  IdempotencyPayloadConflictForWinError,
  InvalidSettleWinInputError,
  TerminalWinSnapshotMissingError,
  WalletCurrencyMismatchForWinError,
  WalletNotFoundForWinError,
  WalletPlayerMismatchForWinError,
} from './settle-win.errors';

export type SettleWinInput = {
  providerId: string;
  playerId: string;
  walletId: string;
  amount: string;
  currency: string;
  roundId: string;
  gameId: string;
  externalTransactionId: string;
  idempotencyKey: string;
};

export type SettleWinOutput = {
  transactionId: string;
  walletId: string;
  status: 'PROCESSED';
  amount: string;
  currency: string;
  observedBalance: string;
  walletVersion: number;
};

/**
 * SettleWinUseCase — credita o amount recebido (decisão: valor creditado, não
 * bruto/líquido oficial). Sem BET obrigatória; sem exclusão mútua com LOSS.
 *
 * Replay: snapshot em wager_transaction. 23505 → nova UoW.
 */
export class SettleWinUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(input: SettleWinInput): Promise<SettleWinOutput> {
    this.assertInput(input);

    const amount = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!amount.isPositive()) {
      throw new InvalidSettleWinInputError('amount da WIN deve ser positivo');
    }

    const businessPayload: WinBusinessPayload = {
      providerId: input.providerId,
      playerId: input.playerId,
      walletId: input.walletId,
      amount: amount.toString(),
      currency: amount.currency,
      roundId: input.roundId,
      gameId: input.gameId,
      externalTransactionId: input.externalTransactionId,
      kind: 'WIN',
    };
    const payloadHash = computeWinPayloadHash(businessPayload);

    try {
      return await this.unitOfWork.run((repos) =>
        this.processWin(repos, input, amount, payloadHash),
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
        throw new ExternalTransactionConflictForWinError(
          input.providerId,
          input.externalTransactionId,
        );
      }
      throw error;
    }
  }

  private async processWin(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    input: SettleWinInput,
    amount: Money,
    payloadHash: string,
  ): Promise<SettleWinOutput> {
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
      throw new WalletNotFoundForWinError(input.walletId);
    }

    if (wallet.playerId !== input.playerId) {
      throw new WalletPlayerMismatchForWinError();
    }

    if (wallet.currency !== amount.currency) {
      throw new WalletCurrencyMismatchForWinError();
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
    input: SettleWinInput,
    payloadHash: string,
  ): Promise<SettleWinOutput> {
    const balanceBefore = wallet.balance;
    wallet.credit(amount);
    const snapshot = captureWalletSnapshot(wallet);

    const transaction = WagerTransaction.winProcessed({
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

    const ledgerEntry = WalletLedgerEntry.credit({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      money: amount,
      balanceBefore,
      balanceAfter: wallet.balance,
    });

    const correlationId = input.idempotencyKey;
    const processedEvent = buildWagerTransactionProcessedEvent({
      transaction,
      observedBalance: snapshot.observedBalance.toString(),
      correlationId,
    });
    const balanceEvent = buildWalletBalanceChangedEvent({
      wallet,
      ledgerEntry,
      correlationId,
      causationId: processedEvent.eventId,
    });

    await repos.wallets.save(wallet);
    await repos.wagerTransactions.save(transaction);
    await repos.ledgerEntries.save(ledgerEntry);
    await repos.outboxMessages.save(
      OutboxMessageEntity.fromEnvelope(processedEvent),
    );
    await repos.outboxMessages.save(
      OutboxMessageEntity.fromEnvelope(balanceEvent),
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
  ): Promise<SettleWinOutput> {
    const existing =
      await repos.wagerTransactions.findByProviderIdAndIdempotencyKey(
        providerId,
        idempotencyKey,
      );

    if (!existing) {
      throw new InvalidSettleWinInputError(
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
  ): SettleWinOutput {
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyPayloadConflictForWinError(
        providerId,
        idempotencyKey,
      );
    }

    if (
      existing.observedBalance === null ||
      existing.observedWalletVersion === null
    ) {
      throw new TerminalWinSnapshotMissingError(existing.id);
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

  private assertInput(input: SettleWinInput): void {
    const required: Array<keyof SettleWinInput> = [
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
        throw new InvalidSettleWinInputError(`${field} é obrigatório`);
      }
    }
  }
}
