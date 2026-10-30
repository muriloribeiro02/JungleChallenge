import { randomUUID } from 'node:crypto';
import { Money } from '../../../domain/money/money';
import { OutboxMessage } from '../../../domain/outbox/outbox-message.entity';
import { Wallet } from '../../../domain/wallet/wallet.entity';
import { WalletAlreadyExistsError } from '../../../domain/wallet/wallet.errors';
import { WagerTransaction } from '../../../domain/wager-transaction/wager-transaction.entity';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger/wallet-ledger-entry.entity';
import {
  buildWagerTransactionProcessedEvent,
  buildWalletBalanceChangedEvent,
} from '../../events/wallet-opening.events';
import type { UnitOfWork } from '../../unit-of-work/unit-of-work';
import { InvalidOpenWalletInputError } from './open-wallet.errors';

export type OpenWalletInput = {
  playerId: string;
  currency: string;
  initialBalance: string;
};

export type OpenWalletOutput = {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
};

export class OpenWalletUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletOutput> {
    if (typeof input.playerId !== 'string' || input.playerId.trim() === '') {
      throw new InvalidOpenWalletInputError('playerId é obrigatório');
    }

    const initialBalance = Money.from({
      amount: input.initialBalance,
      currency: input.currency,
    });

    return this.unitOfWork.run(async (repos) => {
      const existing = await repos.wallets.findByPlayerIdAndCurrency(
        input.playerId,
        initialBalance.currency,
      );

      if (existing) {
        throw new WalletAlreadyExistsError(
          input.playerId,
          initialBalance.currency,
        );
      }

      const wallet = Wallet.open({
        id: randomUUID(),
        playerId: input.playerId,
        initialBalance,
      });

      try {
        if (initialBalance.isZero()) {
          await repos.wallets.save(wallet);
          return toOutput(wallet);
        }

        const transaction = WagerTransaction.openingProcessed({
          id: randomUUID(),
          walletId: wallet.id,
          amount: initialBalance,
        });

        const zero = Money.zero(initialBalance.currency);
        const ledgerEntry = WalletLedgerEntry.credit({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: transaction.id,
          money: initialBalance,
          balanceBefore: zero,
          balanceAfter: initialBalance,
        });

        const correlationId = wallet.id;
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
          OutboxMessage.fromEnvelope(processedEvent),
        );
        await repos.outboxMessages.save(
          OutboxMessage.fromEnvelope(balanceEvent),
        );

        return toOutput(wallet);
      } catch (error) {
        if (error instanceof WalletAlreadyExistsError) {
          throw error;
        }
        if (isUniqueViolation(error)) {
          throw new WalletAlreadyExistsError(
            input.playerId,
            initialBalance.currency,
          );
        }
        throw error;
      }
    });
  }
}

function toOutput(wallet: Wallet): OpenWalletOutput {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: string;
    driverError?: { code?: string };
  };

  return (
    candidate.code === '23505' || candidate.driverError?.code === '23505'
  );
}
