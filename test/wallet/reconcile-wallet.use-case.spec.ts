import { randomUUID } from 'node:crypto';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/wallet/reconcile-wallet.use-case';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet.entity';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger/wallet-ledger-entry.entity';
import type { WalletLedgerEntryRepository } from '../../src/domain/wallet-ledger/wallet-ledger-entry.repository';
import type { WalletRepository } from '../../src/domain/wallet/wallet.repository';

class FakeWallets implements WalletRepository {
  constructor(public wallet: Wallet | null) {}
  async save(): Promise<void> {}
  async findById(id: string): Promise<Wallet | null> {
    return this.wallet?.id === id ? this.wallet : null;
  }
  async findByPlayerIdAndCurrency(): Promise<Wallet | null> {
    return null;
  }
  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    return this.findById(id);
  }
}

class FakeLedger implements WalletLedgerEntryRepository {
  constructor(public items: WalletLedgerEntry[]) {}
  async save(): Promise<void> {}
  async listByWalletId() {
    return { items: this.items, nextCursor: null };
  }
  async listAllByWalletId() {
    return this.items;
  }
  async countByWalletId() {
    return this.items.length;
  }
}

class FakeUow implements UnitOfWork {
  constructor(private readonly repos: TransactionalRepositories) {}
  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>) {
    return work(this.repos);
  }
}

describe('ReconcileWalletUseCase (unit)', () => {
  it('marca consistent quando saldo bate com ledger', async () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const entry = WalletLedgerEntry.credit({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: randomUUID(),
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceBefore: Money.zero('BRL'),
      balanceAfter: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const uow = new FakeUow({
      wallets: new FakeWallets(wallet),
      ledgerEntries: new FakeLedger([entry]),
      wagerTransactions: {} as never,
      outboxMessages: {} as never,
      inboxMessages: {} as never,
    });

    const result = await new ReconcileWalletUseCase(uow).execute({
      walletId: wallet.id,
    });

    expect(result.consistent).toBe(true);
    expect(result.difference.amount).toBe('0.00');
    expect(result.checkedEntries).toBe(1);
  });
});
