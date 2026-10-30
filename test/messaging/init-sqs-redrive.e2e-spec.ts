import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { sqsEnv } from '../../src/infrastructure/messaging/sqs.env';

const execFileAsync = promisify(execFile);

/**
 * Redrive LocalStack alinhado a SQS_MAX_RECEIVE_COUNT (fonte única).
 * Não faz purge. Reaplica políticas sem apagar mensagens.
 *
 * Pré-requisito: LocalStack em AWS_ENDPOINT_URL (Compose) com filas do init.
 */
describe('init-sqs redrive (e2e LocalStack)', () => {
  let client: SQSClient;

  beforeAll(() => {
    client = new SQSClient({
      region: sqsEnv.region,
      endpoint: sqsEnv.endpoint,
      credentials: {
        accessKeyId: sqsEnv.accessKeyId,
        secretAccessKey: sqsEnv.secretAccessKey,
      },
    });
  });

  async function ensureQueueUrl(name: string, fifo = false): Promise<string> {
    const created = await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: fifo
          ? {
              FifoQueue: 'true',
              ContentBasedDeduplication: 'true',
              VisibilityTimeout: '30',
            }
          : { VisibilityTimeout: '30' },
      }),
    );
    return created.QueueUrl!;
  }

  async function queueArn(queueUrl: string): Promise<string> {
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    return attrs.Attributes!.QueueArn!;
  }

  async function redrivePolicy(
    queueUrl: string,
  ): Promise<{ deadLetterTargetArn?: string; maxReceiveCount?: string } | null> {
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['RedrivePolicy'],
      }),
    );
    const raw = attrs.Attributes?.RedrivePolicy;
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: string;
    };
  }

  /** Espelha apply_main_redrive do init-sqs.sh (set-queue-attributes). */
  async function applyMainRedrive(
    queueUrl: string,
    dlqArn: string,
    maxReceiveCount: number,
  ): Promise<void> {
    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: String(maxReceiveCount),
          }),
        },
      }),
    );
  }

  it('default / sqsEnv: app e política usam o mesmo maxReceiveCount', () => {
    expect(sqsEnv.maxReceiveCount).toBeGreaterThanOrEqual(1);
    expect(Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5)).toBe(
      sqsEnv.maxReceiveCount,
    );
  });

  it('filas principais recebem RedrivePolicy; DLQs sem redrive', async () => {
    const eventsDlq = await ensureQueueUrl('jungle-wager-events-dlq');
    const events = await ensureQueueUrl('jungle-wager-events');
    const inboundDlq = await ensureQueueUrl(
      'jungle-wager-transactions-dlq.fifo',
      true,
    );
    const inbound = await ensureQueueUrl(
      'jungle-wager-transactions.fifo',
      true,
    );

    const eventsDlqArn = await queueArn(eventsDlq);
    const inboundDlqArn = await queueArn(inboundDlq);

    await applyMainRedrive(events, eventsDlqArn, sqsEnv.maxReceiveCount);
    await applyMainRedrive(inbound, inboundDlqArn, sqsEnv.maxReceiveCount);

    const eventsPolicy = await redrivePolicy(events);
    const inboundPolicy = await redrivePolicy(inbound);
    expect(eventsPolicy?.maxReceiveCount).toBe(String(sqsEnv.maxReceiveCount));
    expect(eventsPolicy?.deadLetterTargetArn).toBe(eventsDlqArn);
    expect(inboundPolicy?.maxReceiveCount).toBe(String(sqsEnv.maxReceiveCount));
    expect(inboundPolicy?.deadLetterTargetArn).toBe(inboundDlqArn);

    expect(await redrivePolicy(eventsDlq)).toBeNull();
    expect(await redrivePolicy(inboundDlq)).toBeNull();
  }, 30_000);

  it('idempotência: aplicar duas vezes mantém a mesma policy', async () => {
    const eventsDlq = await ensureQueueUrl('jungle-wager-events-dlq');
    const events = await ensureQueueUrl('jungle-wager-events');
    const dlqArn = await queueArn(eventsDlq);

    await applyMainRedrive(events, dlqArn, sqsEnv.maxReceiveCount);
    await applyMainRedrive(events, dlqArn, sqsEnv.maxReceiveCount);

    const policy = await redrivePolicy(events);
    expect(policy?.maxReceiveCount).toBe(String(sqsEnv.maxReceiveCount));
  }, 30_000);

  it('fila existente com policy antiga é atualizada (set-queue-attributes)', async () => {
    const eventsDlq = await ensureQueueUrl('jungle-wager-events-dlq');
    const events = await ensureQueueUrl('jungle-wager-events');
    const dlqArn = await queueArn(eventsDlq);

    const stale = Math.max(1, sqsEnv.maxReceiveCount === 2 ? 3 : 2);
    await applyMainRedrive(events, dlqArn, stale);
    expect((await redrivePolicy(events))?.maxReceiveCount).toBe(String(stale));

    await applyMainRedrive(events, dlqArn, sqsEnv.maxReceiveCount);
    expect((await redrivePolicy(events))?.maxReceiveCount).toBe(
      String(sqsEnv.maxReceiveCount),
    );
  }, 30_000);

  it('init-sqs.sh no container aplica SQS_MAX_RECEIVE_COUNT (se LocalStack Compose estiver up)', async () => {
    try {
      await execFileAsync(
        'docker',
        [
          'exec',
          '-e',
          `SQS_MAX_RECEIVE_COUNT=${sqsEnv.maxReceiveCount}`,
          'jungle-localstack',
          'bash',
          '/etc/localstack/init/ready.d/init-sqs.sh',
        ],
        { timeout: 60_000, windowsHide: true },
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stderr =
        error && typeof error === 'object' && 'stderr' in error
          ? String((error as { stderr?: Buffer | string }).stderr ?? '')
          : '';
      const combined = `${msg}\n${stderr}`;
      // Ambiente sem container: pula (CI/local sem compose).
      if (
        /No such container|cannot find the file|is not running|docker daemon/i.test(
          combined,
        )
      ) {
        console.warn('skip: jungle-localstack indisponível —', combined);
        return;
      }
      throw error;
    }

    const events = await ensureQueueUrl('jungle-wager-events');
    const inbound = await ensureQueueUrl(
      'jungle-wager-transactions.fifo',
      true,
    );
    expect((await redrivePolicy(events))?.maxReceiveCount).toBe(
      String(sqsEnv.maxReceiveCount),
    );
    expect((await redrivePolicy(inbound))?.maxReceiveCount).toBe(
      String(sqsEnv.maxReceiveCount),
    );
  }, 90_000);
});
