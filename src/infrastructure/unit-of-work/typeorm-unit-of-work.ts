import type { DataSource, EntityManager } from 'typeorm';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../application/unit-of-work/unit-of-work';
import { TypeOrmOutboxMessageRepository } from '../repository/outbox/typeorm-outbox-message.repository';
import { OutboxMessageOrmEntity } from '../repository/outbox/outbox-message.orm-entity';
import { TypeOrmWagerTransactionRepository } from '../repository/wager-transaction/typeorm-wager-transaction.repository';
import { WagerTransactionOrmEntity } from '../repository/wager-transaction/wager-transaction.orm-entity';
import { TypeOrmWalletLedgerEntryRepository } from '../repository/wallet-ledger/typeorm-wallet-ledger-entry.repository';
import { WalletLedgerEntryOrmEntity } from '../repository/wallet-ledger/wallet-ledger-entry.orm-entity';
import { TypeOrmWalletRepository } from '../repository/wallet/typeorm-wallet.repository';
import { WalletOrmEntity } from '../repository/wallet/wallet.orm-entity';

/**
 * Controla a transação SQL e entrega repositórios ligados ao mesmo EntityManager.
 */
export class TypeOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  async run<T>(
    work: (repos: TransactionalRepositories) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      return work(createTransactionalRepositories(manager));
    });
  }
}

export function createTransactionalRepositories(
  manager: EntityManager,
): TransactionalRepositories {
  return {
    wallets: new TypeOrmWalletRepository(manager.getRepository(WalletOrmEntity)),
    wagerTransactions: new TypeOrmWagerTransactionRepository(
      manager.getRepository(WagerTransactionOrmEntity),
    ),
    ledgerEntries: new TypeOrmWalletLedgerEntryRepository(
      manager.getRepository(WalletLedgerEntryOrmEntity),
    ),
    outboxMessages: new TypeOrmOutboxMessageRepository(
      manager.getRepository(OutboxMessageOrmEntity),
    ),
  };
}
