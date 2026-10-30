import type { WalletLedgerEntry } from './wallet-ledger-entry.entity';

export type LedgerListPage = {
  items: WalletLedgerEntry[];
  nextCursor: string | null;
};

export interface WalletLedgerEntryRepository {
  save(entry: WalletLedgerEntry): Promise<void>;
  /**
   * Lista por wallet com cursor opaco estável (created_at ASC, id ASC).
   */
  listByWalletId(
    walletId: string,
    options: { cursor?: string | null; limit: number },
  ): Promise<LedgerListPage>;
  listAllByWalletId(walletId: string): Promise<WalletLedgerEntry[]>;
  countByWalletId(walletId: string): Promise<number>;
}

export const WALLET_LEDGER_ENTRY_REPOSITORY = Symbol(
  'WALLET_LEDGER_ENTRY_REPOSITORY',
);
