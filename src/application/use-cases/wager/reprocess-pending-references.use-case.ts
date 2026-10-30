import { randomUUID } from 'node:crypto';
import { OutboxMessage as OutboxMessageEntity } from '../../../domain/outbox/outbox-message.entity';
import type { Wallet } from '../../../domain/wallet/wallet.entity';
import {
  FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
  WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
  WAGER_TRANSACTION_STATUS_PROCESSED,
  WAGER_TRANSACTION_STATUS_REJECTED,
  WAGER_TRANSACTION_TYPE_REFUND,
  WAGER_TRANSACTION_TYPE_ROLLBACK,
  type WagerFailureCode,
  type WagerTransaction,
} from '../../../domain/wager-transaction/wager-transaction.entity';
import { ReferenceAlreadyReversedConflictError } from '../../../domain/wager-transaction/wager-transaction.errors';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger/wallet-ledger-entry.entity';
import {
  buildWagerTransactionProcessedEvent,
  buildWalletBalanceChangedEvent,
} from '../../events/wallet-balance.events';
import { buildWagerTransactionRejectedEvent } from '../../events/wager-outcome.events';
import type { UnitOfWork } from '../../ports/unit-of-work';
import { captureWalletSnapshot } from '../../wager/capture-wallet-snapshot';
import { evaluatePendingReversal } from '../../wager/evaluate-pending-reversal';
import {
  InvalidReprocessPendingInputError,
  PendingTransactionNotFoundError,
  WalletNotFoundForReprocessError,
} from './reprocess-pending-references.errors';

export type ReprocessPendingReferencesInput = {
  providerId: string;
  /** external_transaction_id da referência que acabou de existir (ou a reavaliar). */
  externalReference: string;
};

export type ReprocessPendingItemResult = {
  transactionId: string;
  kind: 'REFUND' | 'ROLLBACK';
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'SKIPPED_TERMINAL';
  failureCode?: WagerFailureCode;
  observedBalance?: string;
  walletVersion?: number;
};

export type ReprocessPendingReferencesOutput = {
  providerId: string;
  externalReference: string;
  results: ReprocessPendingItemResult[];
};

type Repos = Parameters<Parameters<UnitOfWork['run']>[0]>[0];

/**
 * ReprocessPendingReferencesUseCase.
 *
 * Localiza PENDING_REFERENCE do mesmo provider + external_reference (ordem
 * created_at, id) e reavalia cada uma com as regras de REFUND/ROLLBACK.
 *
 * Decisões de implementação (não prescritas pelo contrato):
 * - Invocável pela aplicação (ex.: após PlaceBet/WIN/REFUND ou futuro SQS).
 * - Cada pendência em UoW própria (isolamento; falha técnica não marca REJECTED).
 * - Referência ainda ausente → defer (permanece PENDING_REFERENCE).
 * - Lock: SELECT FOR UPDATE da pendência, depois da wallet.
 */
export class ReprocessPendingReferencesUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(
    input: ReprocessPendingReferencesInput,
  ): Promise<ReprocessPendingReferencesOutput> {
    this.assertInput(input);

    const pendings = await this.unitOfWork.run((repos) =>
      repos.wagerTransactions.findPendingByProviderAndExternalReference(
        input.providerId,
        input.externalReference,
      ),
    );

    const results: ReprocessPendingItemResult[] = [];

    for (const pending of pendings) {
      results.push(await this.reprocessOne(pending.id));
    }

    return {
      providerId: input.providerId,
      externalReference: input.externalReference,
      results,
    };
  }

  /**
   * Reprocessa todas as pendências na mesma transação já aberta (Inbox/SQS).
   * Falha técnica propaga e permite rollback do insert da Inbox.
   */
  async executeWithRepos(
    repos: Repos,
    input: ReprocessPendingReferencesInput,
  ): Promise<ReprocessPendingReferencesOutput> {
    this.assertInput(input);

    const pendings =
      await repos.wagerTransactions.findPendingByProviderAndExternalReference(
        input.providerId,
        input.externalReference,
      );

    const results: ReprocessPendingItemResult[] = [];
    for (const pending of pendings) {
      results.push(await this.processLockedPending(repos, pending.id));
    }

    return {
      providerId: input.providerId,
      externalReference: input.externalReference,
      results,
    };
  }

  /**
   * Reprocessa uma pendência por id (útil para concorrência / retry pontual).
   */
  async reprocessOne(pendingTransactionId: string): Promise<ReprocessPendingItemResult> {
    try {
      return await this.unitOfWork.run((repos) =>
        this.processLockedPending(repos, pendingTransactionId),
      );
    } catch (error) {
      if (error instanceof ReferenceAlreadyReversedConflictError) {
        return this.unitOfWork.run((repos) =>
          this.rejectAfterUniqueRace(repos, pendingTransactionId),
        );
      }
      throw error;
    }
  }

  private async processLockedPending(
    repos: Repos,
    pendingTransactionId: string,
  ): Promise<ReprocessPendingItemResult> {
    const pending = await repos.wagerTransactions.findByIdForUpdate(
      pendingTransactionId,
    );
    if (!pending) {
      throw new PendingTransactionNotFoundError(pendingTransactionId);
    }

    if (pending.status !== WAGER_TRANSACTION_STATUS_PENDING_REFERENCE) {
      return {
        transactionId: pending.id,
        kind: pending.kind as 'REFUND' | 'ROLLBACK',
        status: 'SKIPPED_TERMINAL',
        failureCode: pending.failureCode ?? undefined,
        observedBalance: pending.observedBalance?.toString(),
        walletVersion: pending.observedWalletVersion ?? undefined,
      };
    }

    if (
      pending.kind !== WAGER_TRANSACTION_TYPE_REFUND &&
      pending.kind !== WAGER_TRANSACTION_TYPE_ROLLBACK
    ) {
      throw new InvalidReprocessPendingInputError(
        `kind inesperado para reprocessamento: ${pending.kind}`,
      );
    }

    if (!pending.providerId || !pending.externalReference) {
      throw new InvalidReprocessPendingInputError(
        'pendência sem providerId/externalReference',
      );
    }

    const wallet = await repos.wallets.findByIdForUpdate(pending.walletId);
    if (!wallet) {
      throw new WalletNotFoundForReprocessError(pending.walletId);
    }

    const reference =
      await repos.wagerTransactions.findByProviderIdAndExternalTransactionId(
        pending.providerId,
        pending.externalReference,
      );

    const existingProcessed =
      await repos.wagerTransactions.findProcessedReversalByProviderAndExternalReference(
        pending.providerId,
        pending.externalReference,
      );

    const decision = evaluatePendingReversal({
      pending,
      reference,
      existingProcessedReversal: existingProcessed,
      walletBalance: wallet.balance,
    });

    if (decision.outcome === 'defer') {
      return {
        transactionId: pending.id,
        kind: pending.kind,
        status: WAGER_TRANSACTION_STATUS_PENDING_REFERENCE,
      };
    }

    if (decision.outcome === 'reject') {
      return this.persistRejection(
        repos,
        pending,
        wallet,
        decision.failureCode,
        reference?.id ?? null,
      );
    }

    return this.persistProcessed(
      repos,
      pending,
      wallet,
      reference!.id,
      decision.direction,
    );
  }

  private async persistProcessed(
    repos: Repos,
    pending: WagerTransaction,
    wallet: Wallet,
    resolvedInternalReference: string,
    direction: 'CREDIT' | 'DEBIT',
  ): Promise<ReprocessPendingItemResult> {
    const amount = pending.amount;
    const balanceBefore = wallet.balance;

    if (direction === 'CREDIT') {
      wallet.credit(amount);
    } else {
      wallet.debit(amount);
    }

    const snapshot = captureWalletSnapshot(wallet);
    pending.markProcessed(resolvedInternalReference, snapshot);

    const ledgerEntry =
      direction === 'CREDIT'
        ? WalletLedgerEntry.credit({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: pending.id,
            money: amount,
            balanceBefore,
            balanceAfter: wallet.balance,
          })
        : WalletLedgerEntry.debit({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: pending.id,
            money: amount,
            balanceBefore,
            balanceAfter: wallet.balance,
          });

    const correlationId = pending.idempotencyKey ?? pending.id;
    const processedEvent = buildWagerTransactionProcessedEvent({
      transaction: pending,
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
    await repos.wagerTransactions.save(pending);
    await repos.ledgerEntries.save(ledgerEntry);
    await repos.outboxMessages.save(
      OutboxMessageEntity.fromEnvelope(processedEvent),
    );
    await repos.outboxMessages.save(
      OutboxMessageEntity.fromEnvelope(balanceEvent),
    );

    return {
      transactionId: pending.id,
      kind: pending.kind as 'REFUND' | 'ROLLBACK',
      status: WAGER_TRANSACTION_STATUS_PROCESSED,
      observedBalance: snapshot.observedBalance.toString(),
      walletVersion: snapshot.observedWalletVersion,
    };
  }

  private async persistRejection(
    repos: Repos,
    pending: WagerTransaction,
    wallet: Wallet,
    failureCode: WagerFailureCode,
    resolvedInternalReference: string | null,
  ): Promise<ReprocessPendingItemResult> {
    const snapshot = captureWalletSnapshot(wallet);
    pending.markRejected(failureCode, snapshot, resolvedInternalReference);

    const correlationId = pending.idempotencyKey ?? pending.id;
    const rejectedEvent = buildWagerTransactionRejectedEvent({
      transaction: pending,
      observedBalance: snapshot.observedBalance.toString(),
      correlationId,
    });

    await repos.wagerTransactions.save(pending);
    await repos.outboxMessages.save(
      OutboxMessageEntity.fromEnvelope(rejectedEvent),
    );

    return {
      transactionId: pending.id,
      kind: pending.kind as 'REFUND' | 'ROLLBACK',
      status: WAGER_TRANSACTION_STATUS_REJECTED,
      failureCode,
      observedBalance: snapshot.observedBalance.toString(),
      walletVersion: snapshot.observedWalletVersion,
    };
  }

  private async rejectAfterUniqueRace(
    repos: Repos,
    pendingTransactionId: string,
  ): Promise<ReprocessPendingItemResult> {
    const pending = await repos.wagerTransactions.findByIdForUpdate(
      pendingTransactionId,
    );
    if (!pending) {
      throw new PendingTransactionNotFoundError(pendingTransactionId);
    }

    if (pending.status !== WAGER_TRANSACTION_STATUS_PENDING_REFERENCE) {
      return {
        transactionId: pending.id,
        kind: pending.kind as 'REFUND' | 'ROLLBACK',
        status: 'SKIPPED_TERMINAL',
        failureCode: pending.failureCode ?? undefined,
        observedBalance: pending.observedBalance?.toString(),
        walletVersion: pending.observedWalletVersion ?? undefined,
      };
    }

    const wallet = await repos.wallets.findByIdForUpdate(pending.walletId);
    if (!wallet) {
      throw new WalletNotFoundForReprocessError(pending.walletId);
    }

    const reference =
      pending.providerId && pending.externalReference
        ? await repos.wagerTransactions.findByProviderIdAndExternalTransactionId(
            pending.providerId,
            pending.externalReference,
          )
        : null;

    return this.persistRejection(
      repos,
      pending,
      wallet,
      FAILURE_CODE_REFERENCE_ALREADY_REVERSED,
      reference?.id ?? null,
    );
  }

  private assertInput(input: ReprocessPendingReferencesInput): void {
    if (
      typeof input.providerId !== 'string' ||
      input.providerId.trim() === ''
    ) {
      throw new InvalidReprocessPendingInputError('providerId é obrigatório');
    }
    if (
      typeof input.externalReference !== 'string' ||
      input.externalReference.trim() === ''
    ) {
      throw new InvalidReprocessPendingInputError(
        'externalReference é obrigatório',
      );
    }
  }
}
