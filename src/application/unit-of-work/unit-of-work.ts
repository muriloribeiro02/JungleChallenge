import type { OutboxMessageRepository } from '../../domain/outbox/outbox-message.repository';
import type { WagerTransactionRepository } from '../../domain/wager-transaction/wager-transaction.repository';
import type { WalletLedgerEntryRepository } from '../../domain/wallet-ledger/wallet-ledger-entry.repository';
import type { WalletRepository } from '../../domain/wallet/wallet.repository';

export type TransactionalRepositories = {
  wallets: WalletRepository;
  wagerTransactions: WagerTransactionRepository;
  ledgerEntries: WalletLedgerEntryRepository;
  outboxMessages: OutboxMessageRepository;
};

export interface UnitOfWork {
  run<T>(
    work: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
