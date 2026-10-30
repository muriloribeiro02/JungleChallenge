import type { UnitOfWork } from '../../ports/unit-of-work';
import { WalletNotFoundError } from './get-wallet-balance.errors';
import { InvalidListWalletLedgerInputError } from './list-wallet-ledger.errors';

export type ListWalletLedgerInput = {
  walletId: string;
  cursor?: string;
  limit?: number;
};

export type ListWalletLedgerItem = {
  id: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  createdAt: string;
};

export type ListWalletLedgerOutput = {
  items: ListWalletLedgerItem[];
  nextCursor: string | null;
};

export class ListWalletLedgerUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(input: ListWalletLedgerInput): Promise<ListWalletLedgerOutput> {
    if (typeof input.walletId !== 'string' || input.walletId.trim() === '') {
      throw new InvalidListWalletLedgerInputError('walletId é obrigatório');
    }

    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidListWalletLedgerInputError(
        'limit deve ser inteiro entre 1 e 100',
      );
    }

    return this.unitOfWork.run(async (repos) => {
      const wallet = await repos.wallets.findById(input.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(input.walletId);
      }

      const page = await repos.ledgerEntries.listByWalletId(input.walletId, {
        cursor: input.cursor,
        limit,
      });

      return {
        items: page.items.map((entry) => ({
          id: entry.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }
}
