import type { DataSource } from 'typeorm';
import { DomainEventHandler } from '../application/messaging/domain-event-handler';
import { InboxConsumer } from '../application/messaging/inbox-consumer';
import { OutboxPublisher } from '../application/messaging/outbox-publisher';
import type { MessageBus } from '../application/ports/message-bus';
import type { MessagingLogger } from '../application/ports/messaging-logger';
import type { UnitOfWork } from '../application/ports/unit-of-work';
import { GetWalletBalanceUseCase } from '../application/use-cases/wallet/get-wallet-balance.use-case';
import { OpenWalletUseCase } from '../application/use-cases/wallet/open-wallet.use-case';
import { PlaceBetUseCase } from '../application/use-cases/wager/place-bet.use-case';
import { RefundWagerUseCase } from '../application/use-cases/wager/refund-wager.use-case';
import { ReprocessPendingReferencesUseCase } from '../application/use-cases/wager/reprocess-pending-references.use-case';
import { RollbackWagerUseCase } from '../application/use-cases/wager/rollback-wager.use-case';
import { SettleLossUseCase } from '../application/use-cases/wager/settle-loss.use-case';
import { SettleWinUseCase } from '../application/use-cases/wager/settle-win.use-case';
import { ConsoleMessagingLogger } from '../infrastructure/logging/console-messaging-logger';
import { SqsMessageBus } from '../infrastructure/messaging/sqs-message-bus';
import { sqsEnv } from '../infrastructure/messaging/sqs.env';
import { TypeOrmUnitOfWork } from '../infrastructure/unit-of-work/typeorm-unit-of-work';
import { TypeOrmWalletRepository } from '../infrastructure/repository/wallet/typeorm-wallet.repository';
import { WalletOrmEntity } from '../infrastructure/repository/wallet/wallet.orm-entity';

export type AppComposition = {
  dataSource: DataSource;
  unitOfWork: UnitOfWork;
  messageBus: MessageBus;
  logger: MessagingLogger;
  openWallet: OpenWalletUseCase;
  getWalletBalance: GetWalletBalanceUseCase;
  placeBet: PlaceBetUseCase;
  settleWin: SettleWinUseCase;
  settleLoss: SettleLossUseCase;
  refundWager: RefundWagerUseCase;
  rollbackWager: RollbackWagerUseCase;
  reprocessPending: ReprocessPendingReferencesUseCase;
  domainEventHandler: DomainEventHandler;
  outboxPublisher: OutboxPublisher;
  inboxConsumer: InboxConsumer;
};

/**
 * Composition root: monta ports e use cases sem HTTP.
 * Controllers futuros devem consumir este grafo, não reinstanciar adapters.
 */
export function createAppComposition(dataSource: DataSource): AppComposition {
  const unitOfWork = new TypeOrmUnitOfWork(dataSource);
  const messageBus = SqsMessageBus.fromEnv(sqsEnv.mainQueueUrl);
  const logger = new ConsoleMessagingLogger();

  const openWallet = new OpenWalletUseCase(unitOfWork);
  const getWalletBalance = new GetWalletBalanceUseCase(
    new TypeOrmWalletRepository(dataSource.getRepository(WalletOrmEntity)),
  );
  const placeBet = new PlaceBetUseCase(unitOfWork);
  const settleWin = new SettleWinUseCase(unitOfWork);
  const settleLoss = new SettleLossUseCase(unitOfWork);
  const refundWager = new RefundWagerUseCase(unitOfWork);
  const rollbackWager = new RollbackWagerUseCase(unitOfWork);
  const reprocessPending = new ReprocessPendingReferencesUseCase(unitOfWork);
  const domainEventHandler = new DomainEventHandler(reprocessPending);

  const outboxPublisher = new OutboxPublisher(unitOfWork, messageBus, logger, {
    batchSize: sqsEnv.publisherBatchSize,
    leaseSeconds: sqsEnv.claimLeaseSeconds,
  });

  const inboxConsumer = new InboxConsumer(
    messageBus,
    unitOfWork,
    domainEventHandler,
    logger,
    {
      maxMessages: sqsEnv.receiveMaxMessages,
      waitSeconds: sqsEnv.receiveWaitSeconds,
    },
  );

  return {
    dataSource,
    unitOfWork,
    messageBus,
    logger,
    openWallet,
    getWalletBalance,
    placeBet,
    settleWin,
    settleLoss,
    refundWager,
    rollbackWager,
    reprocessPending,
    domainEventHandler,
    outboxPublisher,
    inboxConsumer,
  };
}
