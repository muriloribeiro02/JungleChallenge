import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { DataSource } from 'typeorm';
import { DomainEventHandler } from '../../src/application/messaging/domain-event-handler';
import { InboxConsumer } from '../../src/application/messaging/inbox-consumer';
import { OutboxPublisher } from '../../src/application/messaging/outbox-publisher';
import type { MessageBus } from '../../src/application/ports/message-bus';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import { PlaceBetUseCase } from '../../src/application/use-cases/wager/place-bet.use-case';
import { RefundWagerUseCase } from '../../src/application/use-cases/wager/refund-wager.use-case';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/wager/reprocess-pending-references.use-case';
import dataSource from '../../src/infrastructure/database/data-source';
import { ConsoleMessagingLogger } from '../../src/infrastructure/logging/console-messaging-logger';
import { SqsMessageBus } from '../../src/infrastructure/messaging/sqs-message-bus';
import { sqsEnv } from '../../src/infrastructure/messaging/sqs.env';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';

const messagingLogger = new ConsoleMessagingLogger();
const publisherOptions = {
  batchSize: sqsEnv.publisherBatchSize,
  leaseSeconds: sqsEnv.claimLeaseSeconds,
};
const consumerOptions = {
  maxMessages: sqsEnv.receiveMaxMessages,
  waitSeconds: sqsEnv.receiveWaitSeconds,
};

function makePublisher(uow: UnitOfWork, messageBus: MessageBus): OutboxPublisher {
  return new OutboxPublisher(
    uow,
    messageBus,
    messagingLogger,
    publisherOptions,
  );
}

function makeHandler(uow: UnitOfWork): DomainEventHandler {
  return new DomainEventHandler(new ReprocessPendingReferencesUseCase(uow));
}

function makeConsumer(
  messageBus: MessageBus,
  uow: UnitOfWork,
  handler: DomainEventHandler,
  options = consumerOptions,
): InboxConsumer {
  return new InboxConsumer(
    messageBus,
    uow,
    handler,
    messagingLogger,
    options,
  );
}

/**
 * Integração real: PostgreSQL + LocalStack SQS.
 * Pré-requisito: docker compose up -d postgres localstack && bun run migration:run
 */
describe('Messaging Outbox/Inbox + SQS (e2e)', () => {
  let connection: DataSource;
  let sqs: SQSClient;
  let bus: SqsMessageBus;
  let dlqBus: SqsMessageBus;
  let publisher: OutboxPublisher;
  let consumer: InboxConsumer;
  let openWallet: OpenWalletUseCase;
  let placeBet: PlaceBetUseCase;
  let refund: RefundWagerUseCase;
  const walletIds: string[] = [];

  beforeAll(async () => {
    connection = dataSource;
    if (!connection.isInitialized) {
      await connection.initialize();
    }
    await connection.runMigrations();

    sqs = new SQSClient({
      region: sqsEnv.region,
      endpoint: sqsEnv.endpoint,
      credentials: {
        accessKeyId: sqsEnv.accessKeyId,
        secretAccessKey: sqsEnv.secretAccessKey,
      },
    });

    // Garante filas (idempotente se init-sqs já rodou)
    await ensureQueues(sqs);

    bus = SqsMessageBus.fromEnv(sqsEnv.mainQueueUrl);
    dlqBus = SqsMessageBus.fromEnv(sqsEnv.dlqUrl);
    const uow = new TypeOrmUnitOfWork(connection);
    publisher = makePublisher(uow, bus);
    openWallet = new OpenWalletUseCase(uow);
    placeBet = new PlaceBetUseCase(uow);
    refund = new RefundWagerUseCase(uow);
    consumer = makeConsumer(bus, uow, makeHandler(uow));

    await purge(sqs, sqsEnv.mainQueueUrl);
    await purge(sqs, sqsEnv.dlqUrl);
  }, 60_000);

  afterEach(async () => {
    await purge(sqs, sqsEnv.mainQueueUrl);
    await purge(sqs, sqsEnv.dlqUrl);

    if (walletIds.length === 0) {
      return;
    }
    const qr = connection.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SET LOCAL session_replication_role = 'replica'`);
      await qr.query(
        `DELETE FROM inbox_message WHERE id IN (
           SELECT id::text FROM outbox_message WHERE aggregate_id IN (
             SELECT id FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])
           )
         )`,
        [walletIds],
      );
      await qr.query(
        `
          DELETE FROM outbox_message
          WHERE aggregate_id = ANY($1::uuid[])
             OR aggregate_id IN (
               SELECT id FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])
             )
        `,
        [walletIds],
      );
      await qr.query(
        `DELETE FROM wallet_ledger_entry WHERE wallet_id = ANY($1::uuid[])`,
        [walletIds],
      );
      await qr.query(
        `DELETE FROM wager_transaction WHERE wallet_id = ANY($1::uuid[])`,
        [walletIds],
      );
      await qr.query(`DELETE FROM wallet WHERE id = ANY($1::uuid[])`, [
        walletIds,
      ]);
      await qr.commitTransaction();
    } catch (error) {
      await qr.rollbackTransaction();
      throw error;
    } finally {
      await qr.release();
      walletIds.length = 0;
    }
  });

  afterAll(async () => {
    if (connection?.isInitialized) {
      await connection.destroy();
    }
  });

  async function seedWallet(balance: string) {
    const playerId = randomUUID();
    const wallet = await openWallet.execute({
      playerId,
      currency: 'BRL',
      initialBalance: balance,
    });
    walletIds.push(wallet.id);
    return { playerId, wallet };
  }

  it('1) publica eventos da outbox no SQS e marca published_at', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    await placeBet.execute({
      providerId: 'provider-msg',
      playerId,
      walletId: wallet.id,
      amount: '10.00',
      currency: 'BRL',
      roundId: 'r1',
      gameId: 'g1',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
    });

    const before = await connection.query(
      `SELECT COUNT(*)::int AS c FROM outbox_message WHERE published_at IS NULL AND aggregate_id IN (
         SELECT id FROM wager_transaction WHERE wallet_id = $1
       )`,
      [wallet.id],
    );
    expect(before[0].c).toBeGreaterThan(0);

    const result = await publisher.publishBatch();
    expect(result.published).toBeGreaterThan(0);

    const unpublished = await connection.query(
      `SELECT COUNT(*)::int AS c FROM outbox_message WHERE published_at IS NULL AND aggregate_id IN (
         SELECT id FROM wager_transaction WHERE wallet_id = $1
       )`,
      [wallet.id],
    );
    expect(unpublished[0].c).toBe(0);

    const received = await bus.receive(10, 1);
    expect(received.length).toBeGreaterThan(0);
  });

  it('2) falha no envio agenda retry (next_attempt_at) e depois publica', async () => {
    const { playerId, wallet } = await seedWallet('50.00');
    await placeBet.execute({
      providerId: 'provider-msg',
      playerId,
      walletId: wallet.id,
      amount: '5.00',
      currency: 'BRL',
      roundId: 'r1',
      gameId: 'g1',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
    });

    const failingBus: typeof bus = Object.create(bus);
    failingBus.publish = async () => {
      throw new Error('forced-publish-fail');
    };
    const failingPublisher = makePublisher(
      new TypeOrmUnitOfWork(connection),
      failingBus,
    );
    const failed = await failingPublisher.publishBatch();
    expect(failed.failed).toBeGreaterThan(0);

    await connection.query(
      `UPDATE outbox_message SET next_attempt_at = NOW() - interval '1 second'
       WHERE published_at IS NULL AND aggregate_id IN (
         SELECT id FROM wager_transaction WHERE wallet_id = $1
       )`,
      [wallet.id],
    );

    const ok = await publisher.publishBatch();
    expect(ok.published).toBeGreaterThan(0);
  });

  it('3) dois publishers concorrentes não publicam o mesmo evento duas vezes no banco', async () => {
    // Isola o lote: demais unpublished não entram no claim concorrente
    await connection.query(
      `UPDATE outbox_message SET published_at = COALESCE(published_at, NOW()), locked_until = NULL
       WHERE published_at IS NULL`,
    );

    const { playerId, wallet } = await seedWallet('80.00');
    await placeBet.execute({
      providerId: 'provider-msg',
      playerId,
      walletId: wallet.id,
      amount: '8.00',
      currency: 'BRL',
      roundId: 'r1',
      gameId: 'g1',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
    });

    const pending = await connection.query(
      `SELECT id FROM outbox_message
       WHERE published_at IS NULL
         AND (
           aggregate_id = $1
           OR aggregate_id IN (
             SELECT id FROM wager_transaction WHERE wallet_id = $1
           )
         )`,
      [wallet.id],
    );
    expect(pending.length).toBeGreaterThan(0);

    const uowPub = new TypeOrmUnitOfWork(connection);
    const p1 = makePublisher(uowPub, bus);
    const p2 = makePublisher(uowPub, bus);
    const p3 = makePublisher(uowPub, bus);

    const [a, b, c] = await Promise.all([
      p1.publishBatch(),
      p2.publishBatch(),
      p3.publishBatch(),
    ]);

    const totalClaimed = a.claimed + b.claimed + c.claimed;
    const totalPublished = a.published + b.published + c.published;
    expect(totalClaimed).toBe(pending.length);
    expect(totalPublished).toBe(pending.length);

    const stillOpen = await connection.query(
      `SELECT COUNT(*)::int AS c FROM outbox_message
       WHERE id = ANY($1::uuid[]) AND published_at IS NULL`,
      [pending.map((r: { id: string }) => r.id)],
    );
    expect(stillOpen[0].c).toBe(0);
  });

  it('4-5-7-13) processa; worker morto pós-commit pré-ACK; redelivery sem efeito financeiro duplicado', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const betExt = randomUUID();

    const pending = await refund.execute({
      providerId: 'provider-msg',
      playerId,
      walletId: wallet.id,
      amount: '20.00',
      currency: 'BRL',
      roundId: 'r1',
      gameId: 'g1',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId: betExt,
    });
    expect(pending.status).toBe('PENDING_REFERENCE');

    await placeBet.execute({
      providerId: 'provider-msg',
      playerId,
      walletId: wallet.id,
      amount: '20.00',
      currency: 'BRL',
      roundId: 'r1',
      gameId: 'g1',
      externalTransactionId: betExt,
      idempotencyKey: randomUUID(),
    });

    await publisher.publishBatch();

    const first = await consumer.pollOnce();
    expect(first.processed + first.duplicates).toBeGreaterThan(0);

    const bal1 = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal1[0].balance)).toContain('100');

    const tx = await connection.query(
      `SELECT status FROM wager_transaction WHERE id = $1`,
      [pending.transactionId],
    );
    expect(tx[0].status).toBe('PROCESSED');

    // Simula worker morto após commit / redelivery: republish same event body
    const processedOutbox = await connection.query(
      `
        SELECT payload FROM outbox_message
        WHERE event_type = 'WagerTransactionProcessed'
          AND aggregate_id IN (
            SELECT id FROM wager_transaction
            WHERE wallet_id = $1 AND kind = 'BET'
          )
        LIMIT 1
      `,
      [wallet.id],
    );
    const payload = processedOutbox[0].payload;
    await bus.publish({
      id: payload.eventId,
      body: JSON.stringify(payload),
    });

    const second = await consumer.pollOnce();
    expect(second.duplicates).toBeGreaterThanOrEqual(1);

    const ledger = await connection.query(
      `SELECT COUNT(*)::int AS c FROM wallet_ledger_entry WHERE transaction_id = $1`,
      [pending.transactionId],
    );
    expect(ledger[0].c).toBe(1);

    const bal2 = await connection.query(
      `SELECT balance::text AS balance FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal2[0].balance)).toContain('100');
  });

  it('6) falha antes do commit não grava inbox e permite redelivery', async () => {
    const uow = new TypeOrmUnitOfWork(connection);
    const exploding = makeConsumer(
      bus,
      uow,
      {
        handleWithRepos: async () => {
          throw new Error('boom-handler');
        },
      } as unknown as DomainEventHandler,
    );

    const eventId = randomUUID();
    await bus.publish({
      id: eventId,
      body: JSON.stringify({
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId: randomUUID(),
        correlationId: 'x',
        occurredAt: new Date().toISOString(),
        version: 1,
        data: { transactionId: randomUUID(), kind: 'BET' },
      }),
    });

    const result = await exploding.pollOnce();
    expect(result.failed).toBeGreaterThan(0);

    const inbox = await connection.query(
      `SELECT 1 FROM inbox_message WHERE id = $1`,
      [eventId],
    );
    expect(inbox).toHaveLength(0);
  });

  it('8-10) redelivery após visibility curta; publisher recupera claim com lease expirado', async () => {
    const eventId = randomUUID();
    await bus.publish({
      id: eventId,
      body: JSON.stringify({
        eventId,
        eventType: 'WalletBalanceChanged',
        aggregateId: randomUUID(),
        correlationId: 'vt-recover',
        occurredAt: new Date().toISOString(),
        version: 1,
        data: { transactionId: randomUUID() },
      }),
    });

    const received = await bus.receive(1, 1);
    expect(received).toHaveLength(1);
    // VisibilityTimeout curto → mensagem volta à fila (redelivery)
    await bus.changeVisibility!(received[0].receiptHandle, 1);
    await sleep(1500);

    const again = await bus.receive(1, 1);
    expect(again).toHaveLength(1);
    expect(again[0].body).toContain(eventId);
    expect(again[0].receiveCount).toBeGreaterThanOrEqual(2);
    await bus.ack(again[0].receiptHandle);

    // Outbox: lease expirado permite novo claim (recuperação pós-reinício)
    await connection.query(
      `UPDATE outbox_message SET published_at = COALESCE(published_at, NOW())
       WHERE published_at IS NULL`,
    );
    const { playerId, wallet } = await seedWallet('40.00');
    await placeBet.execute({
      providerId: 'provider-msg',
      playerId,
      walletId: wallet.id,
      amount: '4.00',
      currency: 'BRL',
      roundId: 'r1',
      gameId: 'g1',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
    });

    await connection.query(
      `
        UPDATE outbox_message
        SET locked_until = NOW() - interval '1 second', attempts = 1
        WHERE published_at IS NULL
          AND (
            aggregate_id = $1
            OR aggregate_id IN (
              SELECT id FROM wager_transaction WHERE wallet_id = $1
            )
          )
      `,
      [wallet.id],
    );

    const result = await publisher.publishBatch();
    expect(result.claimed).toBeGreaterThan(0);
    expect(result.published).toBe(result.claimed);
  }, 30_000);

  it('9) mensagem que falha repetidamente vai para DLQ (maxReceiveCount)', async () => {
    const eventId = randomUUID();
    await bus.publish({
      id: eventId,
      body: JSON.stringify({
        eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId: randomUUID(),
        correlationId: 'dlq-test',
        occurredAt: new Date().toISOString(),
        version: 1,
        data: { transactionId: randomUUID(), kind: 'BET' },
      }),
    });

    const uow = new TypeOrmUnitOfWork(connection);
    const exploding = makeConsumer(
      bus,
      uow,
      {
        handleWithRepos: async () => {
          throw new Error('always-fail');
        },
      } as unknown as DomainEventHandler,
      { maxMessages: 1, waitSeconds: 0 },
    );

    // Falha → changeVisibility(0) → redelivery imediata até maxReceiveCount
    for (let i = 0; i < sqsEnv.maxReceiveCount + 3; i += 1) {
      await exploding.pollOnce();
      await sleep(200);
    }

    let found = false;
    for (let i = 0; i < 10 && !found; i += 1) {
      const dlqMessages = await dlqBus.receive(10, 1);
      found = dlqMessages.some((m) => m.body.includes(eventId));
      if (!found) {
        await sleep(300);
      }
    }
    expect(found).toBe(true);
  }, 60_000);

  it('11) três consumers concorrentes processam sem duplicar inbox', async () => {
    const eventId = randomUUID();
    await bus.publish({
      id: eventId,
      body: JSON.stringify({
        eventId,
        eventType: 'WalletBalanceChanged',
        aggregateId: randomUUID(),
        correlationId: 'multi',
        occurredAt: new Date().toISOString(),
        version: 1,
        data: { transactionId: randomUUID() },
      }),
    });

    const uow = new TypeOrmUnitOfWork(connection);
    const makeConsumerLocal = () =>
      makeConsumer(bus, uow, makeHandler(uow), {
        maxMessages: 1,
        waitSeconds: 1,
      });

    const results = await Promise.all([
      makeConsumerLocal().pollOnce(),
      makeConsumerLocal().pollOnce(),
      makeConsumerLocal().pollOnce(),
    ]);

    const processed = results.reduce((s, r) => s + r.processed, 0);
    const duplicates = results.reduce((s, r) => s + r.duplicates, 0);
    expect(processed + duplicates).toBeGreaterThanOrEqual(1);

    const inbox = await connection.query(
      `SELECT COUNT(*)::int AS c FROM inbox_message WHERE id = $1`,
      [eventId],
    );
    expect(inbox[0].c).toBe(1);
  });

  it('12-14) atomicidade inbox+wallet+ledger+outbox; saldo/ledger consistentes', async () => {
    const { playerId, wallet } = await seedWallet('100.00');
    const betExt = randomUUID();
    await refund.execute({
      providerId: 'provider-msg',
      playerId,
      walletId: wallet.id,
      amount: '15.00',
      currency: 'BRL',
      roundId: 'r1',
      gameId: 'g1',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      referenceExternalTransactionId: betExt,
    });
    await placeBet.execute({
      providerId: 'provider-msg',
      playerId,
      walletId: wallet.id,
      amount: '15.00',
      currency: 'BRL',
      roundId: 'r1',
      gameId: 'g1',
      externalTransactionId: betExt,
      idempotencyKey: randomUUID(),
    });

    await publisher.publishBatch();
    for (let i = 0; i < 5; i += 1) {
      await consumer.pollOnce();
    }

    const bal = await connection.query(
      `SELECT balance::text AS b FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].b)).toContain('100');

    const ledgerSum = await connection.query(
      `
        SELECT
          COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS delta
        FROM wallet_ledger_entry
        WHERE wallet_id = $1
      `,
      [wallet.id],
    );
    // OPENING 100 + BET -15 + REFUND +15 = 100
    expect(String(ledgerSum[0].delta)).toContain('100');
  });
});

async function ensureQueues(client: SQSClient): Promise<void> {
  const dlq = await client.send(
    new CreateQueueCommand({ QueueName: 'jungle-wager-events-dlq' }),
  );
  const dlqUrl = dlq.QueueUrl!;
  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const dlqArn = dlqAttrs.Attributes!.QueueArn!;

  const main = await client.send(
    new CreateQueueCommand({
      QueueName: 'jungle-wager-events',
    }),
  );
  // CreateQueue é idempotente e não atualiza atributos de fila existente
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: main.QueueUrl!,
      Attributes: {
        VisibilityTimeout: String(sqsEnv.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(sqsEnv.maxReceiveCount),
        }),
      },
    }),
  );
}

async function purge(client: SQSClient, queueUrl: string): Promise<void> {
  try {
    await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  } catch {
    // LocalStack pode rate-limitar purge; ignora
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
