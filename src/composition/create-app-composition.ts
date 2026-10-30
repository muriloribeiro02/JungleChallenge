import type { DataSource } from 'typeorm';
import { DomainEventHandler } from '../application/messaging/domain-event-handler';
import { InboundWagerConsumer } from '../application/messaging/inbound-wager-consumer';
import { InboxConsumer } from '../application/messaging/inbox-consumer';
import { OutboxPublisher } from '../application/messaging/outbox-publisher';
import type { DependencyHealthPort } from '../application/ports/dependency-health';
import type { MessageBus } from '../application/ports/message-bus';
import type {
  MetricsExposition,
  MetricsPort,
} from '../application/ports/metrics';
import type { MessagingLogger } from '../application/ports/messaging-logger';
import type { UnitOfWork } from '../application/ports/unit-of-work';
import { TypeOrmSqsDependencyHealth } from '../infrastructure/health/typeorm-sqs-dependency-health';
import { GetWalletUseCase } from '../application/use-cases/wallet/get-wallet.use-case';
import { GetWalletBalanceUseCase } from '../application/use-cases/wallet/get-wallet-balance.use-case';
import { ListWalletLedgerUseCase } from '../application/use-cases/wallet/list-wallet-ledger.use-case';
import { OpenWalletUseCase } from '../application/use-cases/wallet/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../application/use-cases/wallet/reconcile-wallet.use-case';
import { GetWagerTransactionUseCase } from '../application/use-cases/wager/get-wager-transaction.use-case';
import { PlaceBetUseCase } from '../application/use-cases/wager/place-bet.use-case';
import { RefundWagerUseCase } from '../application/use-cases/wager/refund-wager.use-case';
import { ProcessPendingReferencesUseCase } from '../application/use-cases/wager/process-pending-references.use-case';
import { ReprocessPendingReferencesUseCase } from '../application/use-cases/wager/reprocess-pending-references.use-case';
import { RollbackWagerUseCase } from '../application/use-cases/wager/rollback-wager.use-case';
import { SettleLossUseCase } from '../application/use-cases/wager/settle-loss.use-case';
import { SettleWinUseCase } from '../application/use-cases/wager/settle-win.use-case';
import { ClearOutboxInterventionUseCase } from '../application/use-cases/outbox/clear-outbox-intervention.use-case';
import { SubmitWagerTransactionUseCase } from '../application/use-cases/wager/submit-wager-transaction.use-case';
import { ConsoleMessagingLogger } from '../infrastructure/logging/console-messaging-logger';
import { createPrometheusMetrics } from '../infrastructure/metrics/prometheus-metrics';
import { SqsMessageBus } from '../infrastructure/messaging/sqs-message-bus';
import { sqsEnv } from '../infrastructure/messaging/sqs.env';
import { TypeOrmUnitOfWork } from '../infrastructure/unit-of-work/typeorm-unit-of-work';
import { TypeOrmWalletRepository } from '../infrastructure/repository/wallet/typeorm-wallet.repository';
import { WalletOrmEntity } from '../infrastructure/repository/wallet/wallet.orm-entity';

export type AppComposition = {
  dataSource: DataSource;
  unitOfWork: UnitOfWork;
  messageBus: MessageBus;
  dependencyHealth: DependencyHealthPort;
  logger: MessagingLogger;
  metrics: MetricsPort;
  metricsExposition: MetricsExposition;
  openWallet: OpenWalletUseCase;
  getWallet: GetWalletUseCase;
  getWalletBalance: GetWalletBalanceUseCase;
  listWalletLedger: ListWalletLedgerUseCase;
  reconcileWallet: ReconcileWalletUseCase;
  placeBet: PlaceBetUseCase;
  settleWin: SettleWinUseCase;
  settleLoss: SettleLossUseCase;
  refundWager: RefundWagerUseCase;
  rollbackWager: RollbackWagerUseCase;
  reprocessPending: ReprocessPendingReferencesUseCase;
  processPendingReferences: ProcessPendingReferencesUseCase;
  submitWagerTransaction: SubmitWagerTransactionUseCase;
  getWagerTransaction: GetWagerTransactionUseCase;
  clearOutboxIntervention: ClearOutboxInterventionUseCase;
  domainEventHandler: DomainEventHandler;
  outboxPublisher: OutboxPublisher;
  inboxConsumer: InboxConsumer;
  inboundWagerConsumer: InboundWagerConsumer;
  inboundMessageBus: MessageBus;
};

/**
 * Composition root: monta ports e use cases.
 * Controllers Nest consomem este grafo via providers factory.
 */
export function createAppComposition(dataSource: DataSource): AppComposition {
  const unitOfWork = new TypeOrmUnitOfWork(dataSource);
  const messageBus = SqsMessageBus.fromEnv(sqsEnv.mainQueueUrl);
  const inboundMessageBus = SqsMessageBus.fromEnv(sqsEnv.inboundQueueUrl);
  const dependencyHealth = new TypeOrmSqsDependencyHealth(
    dataSource,
    messageBus,
  );
  const logger = new ConsoleMessagingLogger();
  const prom = createPrometheusMetrics({ dataSource });
  const metrics: MetricsPort = prom;
  const metricsExposition: MetricsExposition = prom;
  const walletRepo = new TypeOrmWalletRepository(
    dataSource.getRepository(WalletOrmEntity),
  );

  const openWallet = new OpenWalletUseCase(unitOfWork);
  const getWallet = new GetWalletUseCase(walletRepo);
  const getWalletBalance = new GetWalletBalanceUseCase(walletRepo);
  const listWalletLedger = new ListWalletLedgerUseCase(unitOfWork);
  const reconcileWallet = new ReconcileWalletUseCase(
    unitOfWork,
    logger,
    metrics,
  );
  const placeBet = new PlaceBetUseCase(unitOfWork);
  const settleWin = new SettleWinUseCase(unitOfWork);
  const settleLoss = new SettleLossUseCase(unitOfWork);
  const refundWager = new RefundWagerUseCase(unitOfWork);
  const rollbackWager = new RollbackWagerUseCase(unitOfWork);
  const reprocessPending = new ReprocessPendingReferencesUseCase(unitOfWork);
  const processPendingReferences = new ProcessPendingReferencesUseCase(
    unitOfWork,
    reprocessPending,
    logger,
    {
      batchSize: Number(process.env.PENDING_REFERENCE_BATCH_SIZE ?? 10),
      leaseSeconds: Number(process.env.PENDING_REFERENCE_LEASE_SECONDS ?? 30),
    },
    metrics,
  );
  const submitWagerTransaction = new SubmitWagerTransactionUseCase(
    unitOfWork,
    placeBet,
    settleWin,
    settleLoss,
    refundWager,
    rollbackWager,
    metrics,
  );
  const getWagerTransaction = new GetWagerTransactionUseCase(unitOfWork);
  const clearOutboxIntervention = new ClearOutboxInterventionUseCase(
    unitOfWork,
    logger,
  );
  const domainEventHandler = new DomainEventHandler(reprocessPending);

  const outboxPublisher = new OutboxPublisher(
    unitOfWork,
    messageBus,
    logger,
    {
      batchSize: sqsEnv.publisherBatchSize,
      leaseSeconds: sqsEnv.claimLeaseSeconds,
    },
    metrics,
  );

  const inboxConsumer = new InboxConsumer(
    messageBus,
    unitOfWork,
    domainEventHandler,
    logger,
    {
      maxMessages: sqsEnv.receiveMaxMessages,
      waitSeconds: sqsEnv.receiveWaitSeconds,
    },
    metrics,
  );

  const inboundWagerConsumer = new InboundWagerConsumer(
    inboundMessageBus,
    unitOfWork,
    submitWagerTransaction,
    logger,
    {
      maxMessages: sqsEnv.receiveMaxMessages,
      waitSeconds: sqsEnv.receiveWaitSeconds,
    },
    metrics,
  );

  return {
    dataSource,
    unitOfWork,
    messageBus,
    dependencyHealth,
    inboundMessageBus,
    logger,
    metrics,
    metricsExposition,
    openWallet,
    getWallet,
    getWalletBalance,
    listWalletLedger,
    reconcileWallet,
    placeBet,
    settleWin,
    settleLoss,
    refundWager,
    rollbackWager,
    reprocessPending,
    processPendingReferences,
    submitWagerTransaction,
    getWagerTransaction,
    clearOutboxIntervention,
    domainEventHandler,
    outboxPublisher,
    inboxConsumer,
    inboundWagerConsumer,
  };
}
