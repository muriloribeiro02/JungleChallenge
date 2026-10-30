import { randomUUID } from 'node:crypto';
import { Money } from '../../../domain/money/money';
import { OutboxMessage as OutboxMessageEntity } from '../../../domain/outbox/outbox-message.entity';
import type { Wallet } from '../../../domain/wallet/wallet.entity';
import {
  FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
  WagerTransaction,
  WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_STATUS_REJECTED,
  type WagerFailureCode,
} from '../../../domain/wager-transaction/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger/wallet-ledger-entry.entity';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  ReferenceAlreadyReversedConflictError,
} from '../../../domain/wager-transaction/wager-transaction.errors';
import {
  buildWagerTransactionProcessedEvent,
  buildWalletBalanceChangedEvent,
} from '../../events/wallet-balance.events';
import {
  buildWagerTransactionPendingReferenceEvent,
  buildWagerTransactionRejectedEvent,
} from '../../events/wager-outcome.events';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../ports/unit-of-work';
import { captureWalletSnapshot } from '../../wager/capture-wallet-snapshot';
import {
  computeRefundPayloadHash,
  type RefundBusinessPayload,
} from '../../wager/canonical-payload-hash';
import { validateRefundReference } from '../../wager/validate-reversal-reference';
import {
  ExternalTransactionConflictForRefundError,
  IdempotencyPayloadConflictForRefundError,
  InvalidRefundWagerInputError,
  TerminalRefundSnapshotMissingError,
  WalletCurrencyMismatchForRefundError,
  WalletNotFoundForRefundError,
  WalletPlayerMismatchForRefundError,
} from './refund-wager.errors';

export type RefundWagerInput = {
  providerId: string;
  playerId: string;
  walletId: string;
  amount: string;
  currency: string;
  roundId: string;
  gameId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  referenceExternalTransactionId: string;
};

export type RefundWagerOutput = {
  transactionId: string;
  walletId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  failureCode?: WagerFailureCode;
  amount: string;
  currency: string;
  observedBalance?: string;
  walletVersion?: number;
};

type Repos = TransactionalRepositories;

/**
 * RefundWagerUseCase — reverte BET PROCESSED (CREDIT).
 * Referência ausente → PENDING_REFERENCE (sem saldo/ledger).
 */
export class RefundWagerUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async executeWithRepos(
    repos: TransactionalRepositories,
    input: RefundWagerInput,
  ): Promise<RefundWagerOutput> {
    this.assertInput(input);

    const amount = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!amount.isPositive()) {
      throw new InvalidRefundWagerInputError(
        'amount do REFUND deve ser positivo',
      );
    }

    const businessPayload: RefundBusinessPayload = {
      providerId: input.providerId,
      playerId: input.playerId,
      walletId: input.walletId,
      amount: amount.toString(),
      currency: amount.currency,
      roundId: input.roundId,
      gameId: input.gameId,
      externalTransactionId: input.externalTransactionId,
      kind: 'REFUND',
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    };
    const payloadHash = computeRefundPayloadHash(businessPayload);

    return this.processRefund(repos, input, amount, payloadHash);
  }

  async execute(input: RefundWagerInput): Promise<RefundWagerOutput> {
    this.assertInput(input);

    const amount = Money.from({
      amount: input.amount,
      currency: input.currency,
    });

    if (!amount.isPositive()) {
      throw new InvalidRefundWagerInputError(
        'amount do REFUND deve ser positivo',
      );
    }

    const businessPayload: RefundBusinessPayload = {
      providerId: input.providerId,
      playerId: input.playerId,
      walletId: input.walletId,
      amount: amount.toString(),
      currency: amount.currency,
      roundId: input.roundId,
      gameId: input.gameId,
      externalTransactionId: input.externalTransactionId,
      kind: 'REFUND',
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    };
    const payloadHash = computeRefundPayloadHash(businessPayload);

    try {
      return await this.unitOfWork.run((repos) =>
        this.processRefund(repos, input, amount, payloadHash),
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
        throw new ExternalTransactionConflictForRefundError(
          input.providerId,
          input.externalTransactionId,
        );
      }
      if (error instanceof ReferenceAlreadyReversedConflictError) {
        return this.unitOfWork.run((repos) =>
          this.persistRejectedAfterRace(
            repos,
            input,
            amount,
            payloadHash,
            FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
          ),
        );
      }
      throw error;
    }
  }

  private async processRefund(
    repos: Repos,
    input: RefundWagerInput,
    amount: Money,
    payloadHash: string,
  ): Promise<RefundWagerOutput> {
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
      throw new WalletNotFoundForRefundError(input.walletId);
    }

    if (wallet.playerId !== input.playerId) {
      throw new WalletPlayerMismatchForRefundError();
    }

    if (wallet.currency !== amount.currency) {
      throw new WalletCurrencyMismatchForRefundError();
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

    const reference =
      await repos.wagerTransactions.findByProviderIdAndExternalTransactionId(
        input.providerId,
        input.referenceExternalTransactionId,
      );

    if (!reference) {
      return this.persistPendingReference(repos, wallet, input, amount, payloadHash);
    }

    const existingRefund =
      await repos.wagerTransactions.findProcessedReversalByProviderAndExternalReference(
        input.providerId,
        input.referenceExternalTransactionId,
      );

    const failureCode = validateRefundReference({
      reference,
      scope: {
        providerId: input.providerId,
        playerId: input.playerId,
        walletId: input.walletId,
        currency: amount.currency,
        roundId: input.roundId,
        amount,
      },
      existingProcessedRefund: existingRefund,
    });

    if (failureCode) {
      return this.persistRejected(
        repos,
        wallet,
        input,
        amount,
        payloadHash,
        failureCode,
        reference.id,
      );
    }

    return this.persistProcessed(
      repos,
      wallet,
      input,
      amount,
      payloadHash,
      reference.id,
    );
  }

  private async persistPendingReference(
    repos: Repos,
    wallet: Wallet,
    input: RefundWagerInput,
    amount: Money,
    payloadHash: string,
  ): Promise<RefundWagerOutput> {
    const transaction = WagerTransaction.refundPendingReference({
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
      externalReference: input.referenceExternalTransactionId,
    });

    const pendingEvent = buildWagerTransactionPendingReferenceEvent({
      transaction,
      correlationId: input.idempotencyKey,
    });

    await repos.wagerTransactions.save(transaction);
    await repos.outboxMessages.save(
      OutboxMessageEntity.fromEnvelope(pendingEvent),
    );

    return {
      transactionId: transaction.id,
      walletId: wallet.id,
      status: WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
      amount: amount.toString(),
      currency: amount.currency,
    };
  }

  private async persistRejected(
    repos: Repos,
    wallet: Wallet,
    input: RefundWagerInput,
    amount: Money,
    payloadHash: string,
    failureCode: WagerFailureCode,
    resolvedInternalReference: string | null,
  ): Promise<RefundWagerOutput> {
    const snapshot = captureWalletSnapshot(wallet);
    const transaction = WagerTransaction.refundRejected({
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
      externalReference: input.referenceExternalTransactionId,
      resolvedInternalReference,
      failureCode,
      snapshot,
    });

    const rejectedEvent = buildWagerTransactionRejectedEvent({
      transaction,
      observedBalance: snapshot.observedBalance.toString(),
      correlationId: input.idempotencyKey,
    });

    await repos.wagerTransactions.save(transaction);
    await repos.outboxMessages.save(
      OutboxMessageEntity.fromEnvelope(rejectedEvent),
    );

    return {
      transactionId: transaction.id,
      walletId: wallet.id,
      status: WAGER_TRANSACTION_STATUS_REJECTED,
      failureCode,
      amount: amount.toString(),
      currency: amount.currency,
      observedBalance: snapshot.observedBalance.toString(),
      walletVersion: snapshot.observedWalletVersion,
    };
  }

  private async persistRejectedAfterRace(
    repos: Repos,
    input: RefundWagerInput,
    amount: Money,
    payloadHash: string,
    failureCode: WagerFailureCode,
  ): Promise<RefundWagerOutput> {
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
      throw new WalletNotFoundForRefundError(input.walletId);
    }

    const reference =
      await repos.wagerTransactions.findByProviderIdAndExternalTransactionId(
        input.providerId,
        input.referenceExternalTransactionId,
      );

    return this.persistRejected(
      repos,
      wallet,
      input,
      amount,
      payloadHash,
      failureCode,
      reference?.id ?? null,
    );
  }

  private async persistProcessed(
    repos: Repos,
    wallet: Wallet,
    input: RefundWagerInput,
    amount: Money,
    payloadHash: string,
    resolvedInternalReference: string,
  ): Promise<RefundWagerOutput> {
    const balanceBefore = wallet.balance;
    wallet.credit(amount);
    const snapshot = captureWalletSnapshot(wallet);

    const transaction = WagerTransaction.refundProcessed({
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
      externalReference: input.referenceExternalTransactionId,
      resolvedInternalReference,
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
    repos: Repos,
    providerId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<RefundWagerOutput> {
    const existing =
      await repos.wagerTransactions.findByProviderIdAndIdempotencyKey(
        providerId,
        idempotencyKey,
      );

    if (!existing) {
      throw new InvalidRefundWagerInputError(
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
  ): RefundWagerOutput {
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyPayloadConflictForRefundError(
        providerId,
        idempotencyKey,
      );
    }

    if (existing.status === WAGER_TRANSACTION_STATUS_PENDING_REFERENCE) {
      return {
        transactionId: existing.id,
        walletId: existing.walletId,
        status: WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
        amount: existing.amount.toString(),
        currency: existing.amount.currency,
      };
    }

    if (
      existing.observedBalance === null ||
      existing.observedWalletVersion === null
    ) {
      throw new TerminalRefundSnapshotMissingError(existing.id);
    }

    return {
      transactionId: existing.id,
      walletId: existing.walletId,
      status: existing.status as 'PROCESSED' | 'REJECTED',
      failureCode: existing.failureCode ?? undefined,
      amount: existing.amount.toString(),
      currency: existing.amount.currency,
      observedBalance: existing.observedBalance.toString(),
      walletVersion: existing.observedWalletVersion,
    };
  }

  private assertInput(input: RefundWagerInput): void {
    const required: Array<keyof RefundWagerInput> = [
      'providerId',
      'playerId',
      'walletId',
      'amount',
      'currency',
      'roundId',
      'gameId',
      'externalTransactionId',
      'idempotencyKey',
      'referenceExternalTransactionId',
    ];

    for (const field of required) {
      const value = input[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidRefundWagerInputError(`${field} é obrigatório`);
      }
    }
  }
}
