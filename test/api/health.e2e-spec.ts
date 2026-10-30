import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { resetShutdownGate } from '../../src/application/messaging/shutdown-gate';
import { APP_COMPOSITION } from '../../src/composition/tokens';
import type { AppComposition } from '../../src/composition/create-app-composition';
import dataSource from '../../src/infrastructure/database/data-source';
import { MessagingWorkersHost } from '../../src/infrastructure/messaging/messaging-workers.host';

/**
 * Health e2e: happy path usa PG+SQS reais.
 * Indisponibilidade via spies no adapter (DataSource / MessageBus),
 * sem derrubar LocalStack/Postgres.
 */
describe('Health HTTP (e2e)', () => {
  let app: INestApplication;
  let workers: MessagingWorkersHost;
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
    workers = app.get(MessagingWorkersHost);
    composition = app.get(APP_COMPOSITION);
  }, 60_000);

  afterEach(() => {
    jest.restoreAllMocks();
    (workers as unknown as { stopped: boolean }).stopped = false;
    resetShutdownGate();
  });

  afterAll(async () => {
    (workers as unknown as { stopped: boolean }).stopped = false;
    resetShutdownGate();
    await app?.close();
  });

  it('GET /health/ready — PG e SQS disponíveis → 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(res.body).toEqual({
      status: 'ok',
      postgres: true,
      sqs: true,
    });
  });

  it('GET /health/ready — PostgreSQL indisponível → 503', async () => {
    jest
      .spyOn(composition.dataSource, 'query')
      .mockRejectedValueOnce(new Error('simulated-pg-unavailable'));

    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(res.body).toMatchObject({
      statusCode: 503,
      error: 'NOT_READY',
      message: 'Dependências indisponíveis',
      postgres: false,
      sqs: true,
    });
  });

  it('GET /health/ready — SQS indisponível → 503', async () => {
    jest
      .spyOn(composition.messageBus, 'receive')
      .mockRejectedValueOnce(new Error('simulated-sqs-unavailable'));

    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(res.body).toMatchObject({
      statusCode: 503,
      error: 'NOT_READY',
      message: 'Dependências indisponíveis',
      postgres: true,
      sqs: false,
    });
  });

  it('GET /health/ready — shutdown → 503 SHUTTING_DOWN', async () => {
    await workers.beforeApplicationShutdown('SIGTERM');

    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(res.body).toMatchObject({
      statusCode: 503,
      error: 'SHUTTING_DOWN',
      message: 'Instância em graceful shutdown',
    });
  });

  it('GET /health/live — shutdown → 200 com status stopping', async () => {
    await workers.beforeApplicationShutdown('SIGTERM');

    const res = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);
    expect(res.body.status).toBe('stopping');
    expect(res.body.stopping).toBe(true);
    expect(typeof res.body.instanceId).toBe('string');
    expect(typeof res.body.pid).toBe('number');
  });

  it('GET /health/live — normal → 200 ok', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.stopping).toBe(false);
  });
});
