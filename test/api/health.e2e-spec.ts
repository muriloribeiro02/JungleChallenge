import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { resetShutdownGate } from '../../src/application/messaging/shutdown-gate';
import { APP_COMPOSITION } from '../../src/composition/tokens';
import type { AppComposition } from '../../src/composition/create-app-composition';
import dataSource from '../../src/infrastructure/database/data-source';
import { MessagingWorkersHost } from '../../src/infrastructure/messaging/messaging-workers.host';
import { sqsEnv } from '../../src/infrastructure/messaging/sqs.env';

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
      .spyOn(composition.messageBus, 'checkAvailable')
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

  it('GET /health/ready — não chama receive (sem side effect de visibility)', async () => {
    const receiveSpy = jest.spyOn(composition.messageBus, 'receive');
    const checkSpy = jest.spyOn(composition.messageBus, 'checkAvailable');

    await request(app.getHttpServer()).get('/health/ready').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(checkSpy).toHaveBeenCalled();
    expect(receiveSpy).not.toHaveBeenCalled();
  });

  it('GET /health/ready — não move mensagens para NotVisible (GetQueueAttributes)', async () => {
    const client = new SQSClient({
      region: sqsEnv.region,
      endpoint: sqsEnv.endpoint,
      credentials: {
        accessKeyId: sqsEnv.accessKeyId,
        secretAccessKey: sqsEnv.secretAccessKey,
      },
    });

    const readDepth = async () => {
      const result = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: sqsEnv.mainQueueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
          ],
        }),
      );
      return {
        visible: Number(result.Attributes?.ApproximateNumberOfMessages ?? NaN),
        notVisible: Number(
          result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? NaN,
        ),
      };
    };

    const marker = `health-probe-${Date.now()}-${Math.random()}`;
    await composition.messageBus.publish({
      id: marker,
      body: JSON.stringify({ probe: marker }),
    });

    const before = await readDepth();
    const receiveSpy = jest.spyOn(composition.messageBus, 'receive');

    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    }

    const after = await readDepth();
    expect(receiveSpy).not.toHaveBeenCalled();
    // Probe antigo (ReceiveMessage) aumentaria NotVisible; checkAvailable não.
    expect(after.notVisible).toBe(before.notVisible);
    expect(after.visible).toBeGreaterThanOrEqual(before.visible);

    // Limpeza best-effort da mensagem de probe (não faz parte do assert de health).
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const batch = await composition.messageBus.receive(10, 0);
      for (const msg of batch) {
        if (msg.id === marker || msg.body.includes(marker)) {
          await composition.messageBus.ack(msg.receiptHandle);
          return;
        }
        if (composition.messageBus.changeVisibility) {
          await composition.messageBus.changeVisibility(msg.receiptHandle, 0);
        }
      }
    }
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
