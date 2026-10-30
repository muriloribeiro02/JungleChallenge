import { randomUUID } from 'node:crypto';
import { Money } from '../../../domain/money/money';
import type { OutboxMessage } from '../../../domain/outbox/outbox-message.entity';
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
} from '../../events/wallet-opening.events';
import { buildWagerTransactionRejectedEvent } from '../../events/wager-bet.events';
import type { UnitOfWork } from '../../unit-of-work/unit-of-work';
import {
  computeBetPayloadHash,
  type BetBusinessPayload,
} from '../../wager/canonical-payload-hash';
import {
  ExternalTransactionConflictError,
  IdempotencyPayloadConflictError,
  InvalidPlaceBetInputError,
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
        repos,
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
        repos,
        again,
        payloadHash,
        input.providerId,
        input.idempotencyKey,
      );
    }

    const externalProps = {
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
      return this.persistRejected(
        repos,
        wallet,
        externalProps,
        correlationId,
      );
    }

    return this.persistProcessed(
      repos,
      wallet,
      amount,
      externalProps,
      correlationId,
    );
  }

  private async persistProcessed(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    wallet: Wallet,
    amount: Money,
    externalProps: Parameters<typeof WagerTransaction.betProcessed>[0],
    correlationId: string,
  ): Promise<PlaceBetOutput> {
    const balanceBefore = wallet.balance;
    wallet.debit(amount);

    const transaction = WagerTransaction.betProcessed(externalProps);
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
      observedBalance: wallet.balance.toString(),
      walletVersion: wallet.version,
    };
  }

  private async persistRejected(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    wallet: Wallet,
    externalProps: Parameters<
      typeof WagerTransaction.betRejectedInsufficientFunds
    >[0],
    correlationId: string,
  ): Promise<PlaceBetOutput> {
    const observedBalance = wallet.balance.toString();
    const transaction =
      WagerTransaction.betRejectedInsufficientFunds(externalProps);

    const rejectedEvent = buildWagerTransactionRejectedEvent({
      transaction,
      observedBalance,
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
      observedBalance,
      walletVersion: wallet.version,
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
      repos,
      existing,
      payloadHash,
      providerId,
      idempotencyKey,
    );
  }

  private async buildReplayFromExisting(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    existing: WagerTransaction,
    payloadHash: string,
    providerId: string,
    idempotencyKey: string,
  ): Promise<PlaceBetOutput> {
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyPayloadConflictError(providerId, idempotencyKey);
    }

    // observedBalance vem só dos eventos cujo aggregateId é a própria transação
    // (Processed/Rejected) — não varre o histórico da carteira.
    const txMessages = await repos.outboxMessages.findByAggregateId(
      existing.id,
    );
    const observedBalance = extractObservedBalance(txMessages, existing);

    const walletMessages = await repos.outboxMessages.findByAggregateId(
      existing.walletId,
    );
    const walletVersion = extractWalletVersionForTransaction(
      walletMessages,
      existing.id,
    );

    if (existing.status === WAGER_TRANSACTION_STATUS_REJECTED) {
      return {
        transactionId: existing.id,
        walletId: existing.walletId,
        status: WAGER_TRANSACTION_STATUS_REJECTED,
        failureCode: FAILURE_CODE_INSUFFICIENT_FUNDS,
        amount: existing.amount.toString(),
        currency: existing.amount.currency,
        observedBalance,
        walletVersion,
      };
    }

    return {
      transactionId: existing.id,
      walletId: existing.walletId,
      status: WAGER_TRANSACTION_STATUS_PROCESSED,
      amount: existing.amount.toString(),
      currency: existing.amount.currency,
      observedBalance,
      walletVersion,
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

function extractObservedBalance(
  messages: OutboxMessage[],
  transaction: WagerTransaction,
): string {
  for (const message of messages) {
    const data = message.payload.data as { observedBalance?: string };
    if (typeof data?.observedBalance === 'string') {
      return data.observedBalance;
    }
  }

  throw new InvalidPlaceBetInputError(
    `Replay sem observedBalance na outbox da transação ${transaction.id}`,
  );
}

function extractWalletVersionForTransaction(
  messages: OutboxMessage[],
  transactionId: string,
): number | undefined {
  for (const message of messages) {
    if (message.eventType !== 'WalletBalanceChanged') {
      continue;
    }
    const data = message.payload.data as {
      walletVersion?: number;
      transactionId?: string;
    };
    if (
      data?.transactionId === transactionId &&
      typeof data.walletVersion === 'number'
    ) {
      return data.walletVersion;
    }
  }
  return undefined;
}
