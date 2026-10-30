import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { APP_COMPOSITION } from '../../src/composition/tokens';
import type { AppComposition } from '../../src/composition/create-app-composition';
import dataSource from '../../src/infrastructure/database/data-source';
import { loadPendingReferenceWorkerEnv } from '../../src/infrastructure/config/pending-reference-worker.env';
import { loadSqsEnv } from '../../src/infrastructure/messaging/sqs.env';
import { MessagingWorkersHost } from '../../src/infrastructure/messaging/messaging-workers.host';

const execFileAsync = promisify(execFile);

/**
 * Bootstrap: composição Nest sobe com loaders numéricos válidos;
 * import isolado rejeita env SQS inválido antes de workers.
 */
describe('Env config bootstrap (e2e)', () => {
  let app: INestApplication;
  let composition: AppComposition;

  beforeAll(async () => {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
    await dataSource.runMigrations();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    composition = app.get(APP_COMPOSITION);
    app.get(MessagingWorkersHost);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('Nest inicia com SQS/pending loaders coerentes (defaults ou env válidos)', () => {
    const sqs = loadSqsEnv(process.env);
    const pending = loadPendingReferenceWorkerEnv(process.env);
    expect(sqs.maxReceiveCount).toBeGreaterThanOrEqual(1);
    expect(sqs.receiveWaitSeconds).toBeGreaterThanOrEqual(0);
    expect(sqs.receiveWaitSeconds).toBeLessThanOrEqual(20);
    expect(pending.batchSize).toBeGreaterThanOrEqual(1);
    expect(pending.leaseSeconds).toBeGreaterThanOrEqual(1);
    expect(composition.processPendingReferences).toBeDefined();
    expect(composition.outboxPublisher).toBeDefined();
  });

  it('subprocesso: SQS_RECEIVE_WAIT_SECONDS inválido impede carregar sqs.env', async () => {
    let err: unknown;
    try {
      await execFileAsync(
        'bun',
        [
          '-e',
          `await import('./src/infrastructure/messaging/sqs.env.ts');`,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            SQS_RECEIVE_WAIT_SECONDS: '99',
          },
          timeout: 30_000,
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const combined = `${(err as { stderr?: string; stdout?: string }).stderr ?? ''}${(err as { stdout?: string }).stdout ?? ''}${(err as Error).message ?? ''}`;
    expect(combined).toMatch(/SQS_RECEIVE_WAIT_SECONDS/);
  }, 45_000);
});
