import type { DomainEventEnvelope } from '../../domain/outbox/domain-event';
import type { TransactionalRepositories } from '../unit-of-work/unit-of-work';
import { ReprocessPendingReferencesUseCase } from '../use-cases/wager/reprocess-pending-references.use-case';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';

/**
 * Processa eventos de domínio recebidos via Inbox/SQS.
 * Não duplica regras financeiras — delega aos use cases.
 *
 * Decisão: WagerTransactionProcessed (BET/WIN/REFUND/ROLLBACK) dispara
 * reprocessamento de PENDING_REFERENCE pela externalTransactionId da linha.
 */
export class DomainEventHandler {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Executa efeitos na mesma transação do caller (Inbox insert + negócio).
   */
  async handleWithRepos(
    envelope: DomainEventEnvelope,
    repos: TransactionalRepositories,
  ): Promise<'processed' | 'ignored'> {
    if (envelope.eventType !== 'WagerTransactionProcessed') {
      return 'ignored';
    }

    const data = envelope.data as {
      transactionId?: string;
      kind?: string;
    };

    if (!data.transactionId) {
      return 'ignored';
    }

    if (
      data.kind !== 'BET' &&
      data.kind !== 'WIN' &&
      data.kind !== 'REFUND' &&
      data.kind !== 'ROLLBACK'
    ) {
      return 'ignored';
    }

    const tx = await repos.wagerTransactions.findById(data.transactionId);
    if (!tx?.providerId || !tx.externalTransactionId) {
      return 'ignored';
    }

    const reprocess = new ReprocessPendingReferencesUseCase(this.unitOfWork);
    await reprocess.executeWithRepos(repos, {
      providerId: tx.providerId,
      externalReference: tx.externalTransactionId,
    });

    return 'processed';
  }
}
