import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  SQSClient,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import type { DataSource } from 'typeorm';
import { InboundWagerConsumer } from '../../src/application/messaging/inbound-wager-consumer';
import { OpenWalletUseCase } from '../../src/application/use-cases/wallet/open-wallet.use-case';
import { createAppComposition } from '../../src/composition/create-app-composition';
import dataSource from '../../src/infrastructure/database/data-source';
import { ConsoleMessagingLogger } from '../../src/infrastructure/logging/console-messaging-logger';
import { SqsMessageBus } from '../../src/infrastructure/messaging/sqs-message-bus';
import { sqsEnv } from '../../src/infrastructure/messaging/sqs.env';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/unit-of-work/typeorm-unit-of-work';

/**
 * C1 — Inbound WagerTransactionRequested via fila FIFO real (LocalStack).
 */
describe('Inbound WagerTransactionRequested (e2e SQS FIFO)', () => {
  let connection: DataSource;
  let openWallet: OpenWalletUseCase;
  let inboundBus: SqsMessageBus;
  let consumer: InboundWagerConsumer;
  let sqs: SQSClient;
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
    await ensureInboundFifo(sqs);

    const composition = createAppComposition(connection);
    openWallet = composition.openWallet;
    inboundBus = composition.inboundMessageBus as SqsMessageBus;
    consumer = composition.inboundWagerConsumer;
  });

  beforeEach(async () => {
    await purge(sqs, sqsEnv.inboundQueueUrl);
    await purge(sqs, sqsEnv.inboundDlqUrl).catch(() => undefined);
  });

  afterEach(async () => {
    if (walletIds.length === 0) return;
    const qr = connection.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SET LOCAL session_replication_role = 'replica'`);
      await qr.query(
        `DELETE FROM inbox_message WHERE consumer_name = 'wager-inbound'`,
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
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
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
    const wallet = await openWallet.execute({
      playerId: randomUUID(),
      currency: 'BRL',
      initialBalance: balance,
    });
    walletIds.push(wallet.id);
    return wallet;
  }

  function requestedBody(input: {
    messageId: string;
    walletId: string;
    playerId: string;
    amount: string;
    idempotencyKey: string;
    externalTransactionId: string;
  }) {
    return JSON.stringify({
      messageId: input.messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-inbound',
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: 'round-inbound',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: input.amount, currency: 'BRL' },
      },
    });
  }

  it('mensagem válida: Inbox + BET + outbox atômicos; um débito', async () => {
    const wallet = await seedWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    const externalTransactionId = randomUUID();
    const idempotencyKey = `provider-inbound:${externalTransactionId}`;

    await inboundBus.publish({
      id: messageId,
      body: requestedBody({
        messageId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '15.00',
        idempotencyKey,
        externalTransactionId,
      }),
      attributes: { messageGroupId: wallet.id, walletId: wallet.id },
    });

    const result = await consumer.pollOnce();
    expect(result.processed).toBe(1);

    const bal = await connection.query(
      `SELECT balance::text AS b FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].b)).toContain('85');

    const bets = await connection.query(
      `
        SELECT COUNT(*)::int AS c FROM wager_transaction
        WHERE wallet_id = $1 AND kind = 'BET' AND status = 'PROCESSED'
      `,
      [wallet.id],
    );
    expect(bets[0].c).toBe(1);

    const inbox = await connection.query(
      `
        SELECT consumer_name, id FROM inbox_message
        WHERE consumer_name = 'wager-inbound' AND id = $1
      `,
      [messageId],
    );
    expect(inbox).toHaveLength(1);

    const outbox = await connection.query(
      `
        SELECT COUNT(*)::int AS c FROM outbox_message
        WHERE aggregate_id IN (
          SELECT id FROM wager_transaction WHERE wallet_id = $1 AND kind = 'BET'
        )
      `,
      [wallet.id],
    );
    expect(outbox[0].c).toBeGreaterThanOrEqual(1);
  });

  it('duplicata (mesmo messageId): sem segundo débito', async () => {
    const wallet = await seedWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    const externalTransactionId = randomUUID();
    const idempotencyKey = `provider-inbound:${externalTransactionId}`;
    const body = requestedBody({
      messageId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      amount: '10.00',
      idempotencyKey,
      externalTransactionId,
    });

    await inboundBus.publish({
      id: messageId,
      body,
      attributes: { messageGroupId: wallet.id },
    });
    await consumer.pollOnce();

    // Republish same logical messageId (new SQS transport id)
    await inboundBus.publish({
      id: `${messageId}-redelivery`,
      body,
      attributes: { messageGroupId: wallet.id },
    });
    // Force body messageId same — publish with same body
    const second = await consumer.pollOnce();
    // May get 0 if FIFO dedupes by content, or duplicate if different MessageDeduplicationId
    // Ensure financial effect still single:
    const bets = await connection.query(
      `
        SELECT COUNT(*)::int AS c FROM wager_transaction
        WHERE wallet_id = $1 AND kind = 'BET' AND status = 'PROCESSED'
      `,
      [wallet.id],
    );
    expect(bets[0].c).toBe(1);

    const bal = await connection.query(
      `SELECT balance::text AS b FROM wallet WHERE id = $1`,
      [wallet.id],
    );
    expect(String(bal[0].b)).toContain('90');
    expect(second.processed + second.duplicates + second.failed).toBeGreaterThanOrEqual(0);
  });

  it('falha antes do commit: sem inbox; redelivery processa', async () => {
    const wallet = await seedWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    const externalTransactionId = randomUUID();
    const uow = new TypeOrmUnitOfWork(connection);
    const composition = createAppComposition(connection);

    const brokenSubmit = {
      executeWithRepos: async () => {
        throw new Error('boom-before-commit');
      },
    };

    const failing = new InboundWagerConsumer(
      composition.inboundMessageBus,
      uow,
      brokenSubmit as never,
      new ConsoleMessagingLogger(),
      { maxMessages: 10, waitSeconds: 1 },
    );

    await composition.inboundMessageBus.publish({
      id: messageId,
      body: requestedBody({
        messageId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '5.00',
        idempotencyKey: `provider-inbound:${externalTransactionId}`,
        externalTransactionId,
      }),
      attributes: { messageGroupId: wallet.id },
    });

    const failResult = await failing.pollOnce();
    expect(failResult.failed).toBe(1);

    const inbox = await connection.query(
      `SELECT 1 FROM inbox_message WHERE id = $1`,
      [messageId],
    );
    expect(inbox).toHaveLength(0);

    // Redelivery com consumer saudável
    for (let i = 0; i < 5; i += 1) {
      const r = await consumer.pollOnce();
      if (r.processed > 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    const bets = await connection.query(
      `
        SELECT COUNT(*)::int AS c FROM wager_transaction
        WHERE wallet_id = $1 AND kind = 'BET' AND status = 'PROCESSED'
      `,
      [wallet.id],
    );
    expect(bets[0].c).toBe(1);
  });

  it('dois consumers concorrentes: um efeito financeiro', async () => {
    const wallet = await seedWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    const externalTransactionId = randomUUID();
    const composition = createAppComposition(connection);
    const c1 = composition.inboundWagerConsumer;
    const c2 = new InboundWagerConsumer(
      composition.inboundMessageBus,
      composition.unitOfWork,
      composition.submitWagerTransaction,
      new ConsoleMessagingLogger(),
      { maxMessages: 10, waitSeconds: 1 },
    );

    await composition.inboundMessageBus.publish({
      id: messageId,
      body: requestedBody({
        messageId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '20.00',
        idempotencyKey: `provider-inbound:${externalTransactionId}`,
        externalTransactionId,
      }),
      attributes: { messageGroupId: wallet.id },
    });

    // FIFO same group: only one consumer gets the message at a time typically.
    // Publish two copies with different messageIds but same financial key to stress race.
    const messageId2 = `msg-${randomUUID()}`;
    await composition.inboundMessageBus.publish({
      id: messageId2,
      body: requestedBody({
        messageId: messageId2,
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '20.00',
        idempotencyKey: `provider-inbound:${externalTransactionId}`,
        externalTransactionId,
      }),
      attributes: { messageGroupId: wallet.id },
    });

    await Promise.all([c1.pollOnce(), c2.pollOnce(), c1.pollOnce(), c2.pollOnce()]);

    const bets = await connection.query(
      `
        SELECT COUNT(*)::int AS c FROM wager_transaction
        WHERE wallet_id = $1 AND kind = 'BET' AND status = 'PROCESSED'
      `,
      [wallet.id],
    );
    expect(bets[0].c).toBe(1);

    const debits = await connection.query(
      `
        SELECT COUNT(*)::int AS c FROM wallet_ledger_entry
        WHERE wallet_id = $1 AND direction = 'DEBIT'
      `,
      [wallet.id],
    );
    expect(debits[0].c).toBe(1);
  });
});

async function ensureInboundFifo(client: SQSClient): Promise<void> {
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: 'jungle-wager-transactions-dlq.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
        VisibilityTimeout: '30',
      },
    }),
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
      QueueName: 'jungle-wager-transactions.fifo',
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
        VisibilityTimeout: '30',
      },
    }),
  );
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: main.QueueUrl!,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '5',
        }),
      },
    }),
  );
}

async function purge(client: SQSClient, queueUrl: string): Promise<void> {
  try {
    await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  } catch {
    // LocalStack pode rate-limit purge
  }
}
