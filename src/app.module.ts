import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  createAppComposition,
  type AppComposition,
} from './composition/create-app-composition';
import dataSource from './infrastructure/database/data-source';

export const APP_COMPOSITION = Symbol('APP_COMPOSITION');

/**
 * Shell Nest mínimo (sem controllers/DTOs).
 * Expõe a composition root para a futura camada HTTP.
 */
@Module({
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
  ],
  exports: [APP_COMPOSITION],
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
