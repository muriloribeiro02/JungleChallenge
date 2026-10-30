import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { NoopAuthGuard } from './api/auth/noop-auth.guard';
import { GlobalHttpExceptionFilter } from './api/http/filters/http-exception.filter';
import { HealthController } from './api/http/health/health.controller';
import { MetricsController } from './api/http/metrics/metrics.controller';
import { WalletsController } from './api/http/wallets/wallets.controller';
import { WageringController } from './api/http/wagering/wagering.controller';
import {
  createAppComposition,
  type AppComposition,
} from './composition/create-app-composition';
import { APP_COMPOSITION } from './composition/tokens';
import dataSource from './infrastructure/database/data-source';
import { MessagingWorkersHost } from './infrastructure/messaging/messaging-workers.host';
import { GetWalletUseCase } from './application/use-cases/wallet/get-wallet.use-case';
import { ListWalletLedgerUseCase } from './application/use-cases/wallet/list-wallet-ledger.use-case';
import { OpenWalletUseCase } from './application/use-cases/wallet/open-wallet.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/wallet/reconcile-wallet.use-case';
import { GetWagerTransactionUseCase } from './application/use-cases/wager/get-wager-transaction.use-case';
import { SubmitWagerTransactionUseCase } from './application/use-cases/wager/submit-wager-transaction.use-case';

@Module({
  controllers: [
    HealthController,
    MetricsController,
    WalletsController,
    WageringController,
  ],
  providers: [
    {
      provide: APP_COMPOSITION,
      useFactory: async (): Promise<AppComposition> => {
        if (!dataSource.isInitialized) {
          await dataSource.initialize();
        }
        return createAppComposition(dataSource);
      },
    },
    {
      provide: OpenWalletUseCase,
      inject: [APP_COMPOSITION],
      useFactory: (app: AppComposition) => app.openWallet,
    },
    {
      provide: GetWalletUseCase,
      inject: [APP_COMPOSITION],
      useFactory: (app: AppComposition) => app.getWallet,
    },
    {
      provide: ListWalletLedgerUseCase,
      inject: [APP_COMPOSITION],
      useFactory: (app: AppComposition) => app.listWalletLedger,
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [APP_COMPOSITION],
      useFactory: (app: AppComposition) => app.reconcileWallet,
    },
    {
      provide: SubmitWagerTransactionUseCase,
      inject: [APP_COMPOSITION],
      useFactory: (app: AppComposition) => app.submitWagerTransaction,
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [APP_COMPOSITION],
      useFactory: (app: AppComposition) => app.getWagerTransaction,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalHttpExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: NoopAuthGuard,
    },
    MessagingWorkersHost,
  ],
})
export class AppModule implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}
