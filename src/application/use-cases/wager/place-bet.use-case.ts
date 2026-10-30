import { randomUUID } from 'node:crypto';
import { Money } from '../../../domain/money/money';
import { OutboxMessage as OutboxMessageEntity } from '../../../domain/outbox/outbox-message.entity';
import type { Wallet } from '../../../domain/wallet/wallet.entity';
import {
  FAILURE_CODE_INSUFFICIENT_FUNDS,
  WagerTransaction,
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_STATUS_REJECTED,
} from '../../../domain/wager-transaction/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger/wallet-ledger-entry.entity';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
} from '../../../domain/wager-transaction/wager-transaction.errors';
import {
  buildWagerTransactionProcessedEvent,
  buildWalletBalanceChangedEvent,
} from '../../events/wallet-balance.events';
import { buildWagerTransactionRejectedEvent } from '../../events/wager-outcome.events';
import type { UnitOfWork } from '../../ports/unit-of-work';
import { captureWalletSnapshot } from '../../wager/capture-wallet-snapshot';
import {
  computeBetPayloadHash,
  type BetBusinessPayload,
} from '../../wager/canonical-payload-hash';
import {
  ExternalTransactionConflictError,
  IdempotencyPayloadConflictError,
  InvalidPlaceBetInputError,
  TerminalTransactionSnapshotMissingError,
  WalletCurrencyMismatchForBetError,
  WalletNotFoundForBetError,
  WalletPlayerMismatchError,
} from './place-bet.errors';

export type PlaceBetInput = {
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

export type PlaceBetOutput = {
  transactionId: string;
  walletId: string;
  status: 'PROCESSED' | 'REJECTED';
  failureCode?: 'INSUFFICIENT_FUNDS';
  amount: string;
  currency: string;
  observedBalance: string;
  walletVersion?: number;
};

/**
 * PlaceBetUseCase.
 *
 * Concorrência na carteira: `findByIdForUpdate` (SELECT FOR UPDATE) serializa
 * débitos na mesma wallet e evita lost update / saldo negativo sob race.
 *
 * Idempotência UNIQUE (23505): o Postgres aborta a transação atual. Por isso
 * o conflito é capturado fora do UoW e a releitura/replay ocorre em uma
 * **nova** transação — nunca na mesma conexão abortada.
 *
 * Replay: observedBalance/walletVersion vêm só de wager_transaction (snapshot).
 */
export class PlaceBetUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(input: PlaceBetInput): Promise<PlaceBetOutput> {
    this.assertInput(input);

    const amount = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!amount.isPositive()) {
      throw new InvalidPlaceBetInputError('amount da BET deve ser positivo');
    }

    const businessPayload: BetBusinessPayload = {
      providerId: input.providerId,
      playerId: input.playerId,
      walletId: input.walletId,
      amount: amount.toString(),
      currency: amount.currency,
      roundId: input.roundId,
      gameId: input.gameId,
      externalTransactionId: input.externalTransactionId,
      kind: 'BET',
    };
    const payloadHash = computeBetPayloadHash(businessPayload);

    try {
      return await this.unitOfWork.run((repos) =>
        this.processBet(repos, input, amount, payloadHash),
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
        throw new ExternalTransactionConflictError(
          input.providerId,
          input.externalTransactionId,
        );
      }
      throw error;
    }
  }

  private async processBet(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    input: PlaceBetInput,
    amount: Money,
    payloadHash: string,
  ): Promise<PlaceBetOutput> {
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
      throw new WalletNotFoundForBetError(input.walletId);
    }

    if (wallet.playerId !== input.playerId) {
      throw new WalletPlayerMismatchError();
    }

    if (wallet.currency !== amount.currency) {
      throw new WalletCurrencyMismatchForBetError();
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

    const externalBase = {
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
    };

    const correlationId = input.idempotencyKey;

    if (wallet.balance.isLessThan(amount)) {
      return this.persistRejected(repos, wallet, externalBase, correlationId);
    }

    return this.persistProcessed(
      repos,
      wallet,
      amount,
      externalBase,
      correlationId,
    );
  }

  private async persistProcessed(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    wallet: Wallet,
    amount: Money,
    externalBase: Omit<
      Parameters<typeof WagerTransaction.betProcessed>[0],
      'snapshot'
    >,
    correlationId: string,
  ): Promise<PlaceBetOutput> {
    const balanceBefore = wallet.balance;
    wallet.debit(amount);
    const snapshot = captureWalletSnapshot(wallet);

    const transaction = WagerTransaction.betProcessed({
      ...externalBase,
      snapshot,
    });
    const ledgerEntry = WalletLedgerEntry.debit({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      money: amount,
      balanceBefore,
      balanceAfter: wallet.balance,
    });

    const processedEvent = buildWagerTransactionProcessedEvent({
      transaction,
      observedBalance: wallet.balance.toString(),
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

  private async persistRejected(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    wallet: Wallet,
    externalBase: Omit<
      Parameters<typeof WagerTransaction.betRejectedInsufficientFunds>[0],
      'snapshot'
    >,
    correlationId: string,
  ): Promise<PlaceBetOutput> {
    const snapshot = captureWalletSnapshot(wallet);
    const transaction = WagerTransaction.betRejectedInsufficientFunds({
      ...externalBase,
      snapshot,
    });

    const rejectedEvent = buildWagerTransactionRejectedEvent({
      transaction,
      observedBalance: snapshot.observedBalance.toString(),
      correlationId,
    });

    await repos.wagerTransactions.save(transaction);
    await repos.outboxMessages.save(
      OutboxMessageEntity.fromEnvelope(rejectedEvent),
    );

    return {
      transactionId: transaction.id,
      walletId: wallet.id,
      status: WAGER_TRANSACTION_STATUS_REJECTED,
      failureCode: FAILURE_CODE_INSUFFICIENT_FUNDS,
      amount: transaction.amount.toString(),
      currency: transaction.amount.currency,
      observedBalance: snapshot.observedBalance.toString(),
      walletVersion: snapshot.observedWalletVersion,
    };
  }

  private async replayOrConflict(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    providerId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<PlaceBetOutput> {
    const existing =
      await repos.wagerTransactions.findByProviderIdAndIdempotencyKey(
        providerId,
        idempotencyKey,
      );

    if (!existing) {
      throw new InvalidPlaceBetInputError(
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
  ): PlaceBetOutput {
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyPayloadConflictError(providerId, idempotencyKey);
    }

    if (
      existing.observedBalance === null ||
      existing.observedWalletVersion === null
    ) {
      throw new TerminalTransactionSnapshotMissingError(existing.id);
    }

    if (existing.status === WAGER_TRANSACTION_STATUS_REJECTED) {
      return {
        transactionId: existing.id,
        walletId: existing.walletId,
        status: WAGER_TRANSACTION_STATUS_REJECTED,
        failureCode: FAILURE_CODE_INSUFFICIENT_FUNDS,
        amount: existing.amount.toString(),
        currency: existing.amount.currency,
        observedBalance: existing.observedBalance.toString(),
        walletVersion: existing.observedWalletVersion,
      };
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

  private assertInput(input: PlaceBetInput): void {
    const required: Array<keyof PlaceBetInput> = [
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
        throw new InvalidPlaceBetInputError(`${field} é obrigatório`);
      }
    }
  }
}
