import type { WalletLedgerEntry } from './wallet-ledger-entry.entity';

export interface WalletLedgerEntryRepository {
  save(entry: WalletLedgerEntry): Promise<void>;
}

export const WALLET_LEDGER_ENTRY_REPOSITORY = Symbol(
  'WALLET_LEDGER_ENTRY_REPOSITORY',
);
