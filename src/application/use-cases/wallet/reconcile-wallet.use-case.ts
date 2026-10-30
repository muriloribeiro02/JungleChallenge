import { Money } from '../../../domain/money/money';
import {
  LEDGER_DIRECTION_CREDIT,
  LEDGER_DIRECTION_DEBIT,
} from '../../../domain/wallet-ledger/wallet-ledger-entry.entity';
import {
  elapsedSecondsSince,
  noopMetrics,
  type MetricsPort,
} from '../../ports/metrics';
import type { MessagingLogger } from '../../ports/messaging-logger';
import type { UnitOfWork } from '../../ports/unit-of-work';
import { WalletNotFoundError } from './get-wallet-balance.errors';
import { InvalidReconcileWalletInputError } from './reconcile-wallet.errors';

export type ReconcileWalletInput = {
  walletId: string;
};

export type ReconcileWalletOutput = {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
};

/**
 * Reconcilia saldo materializado vs ledger (somente leitura; não corrige).
 * Divergências são logadas e contadas em métricas (sem expor saldos nos labels).
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly logger?: MessagingLogger,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async execute(input: ReconcileWalletInput): Promise<ReconcileWalletOutput> {
    if (typeof input.walletId !== 'string' || input.walletId.trim() === '') {
      throw new InvalidReconcileWalletInputError('walletId é obrigatório');
    }

    const started = process.hrtime.bigint();
    const output = await this.unitOfWork.run(async (repos) => {
      const wallet = await repos.wallets.findById(input.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(input.walletId);
      }

      const entries = await repos.ledgerEntries.listAllByWalletId(wallet.id);
      let calculated = Money.zero(wallet.currency);

      for (const entry of entries) {
        if (entry.direction === LEDGER_DIRECTION_CREDIT) {
          calculated = calculated.add(entry.money);
        } else if (entry.direction === LEDGER_DIRECTION_DEBIT) {
          calculated = calculated.subtract(entry.money);
        }
      }

      const stored = wallet.balance;
      const difference = absDiff(stored, calculated);
      const consistent = stored.equals(calculated);

      if (!consistent) {
        this.logger?.warn('wallet.reconciliation_divergence', {
          walletId: wallet.id,
          storedBalance: stored.toString(),
          calculatedBalance: calculated.toString(),
          checkedEntries: entries.length,
        });
      }

      return {
        walletId: wallet.id,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries.length,
      };
    });

    this.metrics.recordReconciliation({
      consistent: output.consistent,
      durationSeconds: elapsedSecondsSince(started),
    });
    return output;
  }
}
function absDiff(a: Money, b: Money): Money {
  if (a.isLessThan(b)) {
    return b.subtract(a);
  }
  return a.subtract(b);
}
