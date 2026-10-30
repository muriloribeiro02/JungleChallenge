import { randomUUID } from 'crypto';
import { LEDGER_DIRECTION_CREDIT } from '../../src/domain/wallet-ledger/wallet-ledger-entry.entity';
import { WalletLedgerEntryMapper } from '../../src/infrastructure/repository/wallet-ledger/wallet-ledger-entry.mapper';
import { WalletLedgerEntryOrmEntity } from '../../src/infrastructure/repository/wallet-ledger/wallet-ledger-entry.orm-entity';

describe('WalletLedgerEntryMapper', () => {
  it('rejeita amount com precisão inválida na reidratação', () => {
    const row = new WalletLedgerEntryOrmEntity();
    row.id = randomUUID();
    row.walletId = randomUUID();
    row.transactionId = randomUUID();
    row.direction = LEDGER_DIRECTION_CREDIT;
    row.amount = '1.2350';
    row.currency = 'BRL';
    row.balanceBefore = '10.00';
    row.balanceAfter = '11.24';
    row.createdAt = new Date();

    expect(() => WalletLedgerEntryMapper.toDomain(row)).toThrow(
      /2 casas decimais/,
    );
  });
});
