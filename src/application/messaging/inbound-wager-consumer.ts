import {
  InboxMessage,
  INBOX_CONSUMER_WAGER_INBOUND,
} from '../../domain/inbox/inbox-message.entity';
import { Money } from '../../domain/money/money';
import type { MessageBus, ReceivedBusMessage } from '../ports/message-bus';
import {
  elapsedSecondsSince,
  noopMetrics,
  type MetricsPort,
} from '../ports/metrics';
import type { MessagingLogger } from '../ports/messaging-logger';
import type { UnitOfWork } from '../ports/unit-of-work';
import type {
  SubmitWagerTransactionInput,
  SubmitWagerTransactionOutput,
  SubmitWagerTransactionUseCase,
} from '../use-cases/wager/submit-wager-transaction.use-case';
import {
  trackSqsReceipt,
  untrackSqsReceipt,
} from './active-sqs-receipts';
import { shutdownGate } from './shutdown-gate';
import { applyShutdownTestHoldIfConfigured } from './shutdown-test-hold';

const CONSUMER = 'wager_inbound' as const;

export type InboundWagerConsumerOptions = {
  maxMessages: number;
  waitSeconds: number;
};

export type WagerTransactionRequestedEnvelope = {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
};

/**
 * Consumer inbound §10 — WagerTransactionRequested.
 * Inbox + Submit (efeito + outbox) na mesma UoW; ACK só após commit.
 */
export class InboundWagerConsumer {
  constructor(
    private readonly bus: MessageBus,
    private readonly unitOfWork: UnitOfWork,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly logger: MessagingLogger,
    private readonly options: InboundWagerConsumerOptions,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async pollOnce(): Promise<{
    received: number;
    processed: number;
    duplicates: number;
    failed: number;
  }> {
    const started = process.hrtime.bigint();
    const messages = await this.bus.receive(
      this.options.maxMessages,
      this.options.waitSeconds,
    );
    this.metrics.recordMessagingReceived(CONSUMER, messages.length);
    let processed = 0;
    let duplicates = 0;
    let failed = 0;
    let inFlight = 0;

    for (const message of messages) {
      if (message.receiveCount > 1) {
        this.metrics.recordMessagingRetry(CONSUMER);
      }

      if (shutdownGate.stopping || shutdownGate.abandonInFlight) {
        await this.releaseWithoutAck(message, 'shutdown_before_start');
        failed += 1;
        continue;
      }

      const receiptKey = `inbound:${message.transportMessageId}:${message.receiptHandle}`;
      trackSqsReceipt(
        receiptKey,
        this.bus,
        message.receiptHandle,
        message.transportMessageId,
      );

      try {
        inFlight += 1;
        this.metrics.setMessagingInFlight(CONSUMER, inFlight);
        await applyShutdownTestHoldIfConfigured();

        if (shutdownGate.abandonInFlight) {
          await this.releaseWithoutAck(message, 'shutdown_abandon');
          untrackSqsReceipt(receiptKey);
          failed += 1;
          continue;
        }

        const outcome = await this.consumeOne(message);

        if (shutdownGate.abandonInFlight) {
          await this.releaseWithoutAck(message, 'shutdown_abandon_after_uow');
          untrackSqsReceipt(receiptKey);
          failed += 1;
          continue;
        }

        if (outcome === 'duplicate') {
          duplicates += 1;
        } else {
          processed += 1;
        }
        await this.bus.ack(message.receiptHandle);
        untrackSqsReceipt(receiptKey);
      } catch (error) {
        failed += 1;
        untrackSqsReceipt(receiptKey);
        await this.releaseWithoutAck(message, 'error');
        this.logger.error('inbound.message_failed', {
          transportMessageId: message.transportMessageId,
          receiveCount: message.receiveCount,
          error: error instanceof Error ? error.message : String(error),
          willRetryOrDlq: true,
        });
      } finally {
        inFlight = Math.max(0, inFlight - 1);
        this.metrics.setMessagingInFlight(CONSUMER, inFlight);
      }
    }

    if (processed > 0) {
      this.metrics.recordMessagingProcessed(CONSUMER, processed);
    }
    if (duplicates > 0) {
      this.metrics.recordMessagingDuplicate(CONSUMER, duplicates);
    }
    if (failed > 0) {
      this.metrics.recordMessagingFailed(CONSUMER, failed);
    }
    this.metrics.observeMessagingDuration(
      CONSUMER,
      elapsedSecondsSince(started),
    );

    return {
      received: messages.length,
      processed,
      duplicates,
      failed,
    };
  }

  private async consumeOne(
    message: ReceivedBusMessage,
  ): Promise<'processed' | 'duplicate'> {
    const envelope = parseRequestedEnvelope(message.body);
    const messageId = envelope.messageId;
    const started = process.hrtime.bigint();

    this.logger.info('inbound.message_received', {
      messageId,
      kind: envelope.data.kind,
      transportMessageId: message.transportMessageId,
      receiveCount: message.receiveCount,
      providerId: envelope.data.providerId,
    });

    // Valida Money (string) antes da UoW — rejeição permanente → sem ACK → DLQ
    assertMoneyProps(envelope.data.money);

    const input = toSubmitInput(envelope);
    let submitOutput: SubmitWagerTransactionOutput | null = null;

    const inserted = await this.unitOfWork.run(async (repos) => {
      const first = await repos.inboxMessages.tryInsert(
        InboxMessage.record({
          id: messageId,
          consumerName: INBOX_CONSUMER_WAGER_INBOUND,
          eventType: 'WagerTransactionRequested',
          transportMessageId: message.transportMessageId,
        }),
      );
      if (!first) {
        return false;
      }

      submitOutput = await this.submit.executeWithRepos(repos, input);
      return true;
    });

    if (!inserted) {
      this.logger.info('inbound.message_duplicate', {
        messageId,
        transportMessageId: message.transportMessageId,
      });
      return 'duplicate';
    }

    if (submitOutput) {
      try {
        this.submit.recordMetrics(input.kind, submitOutput, started);
      } catch {
        // instrumentação nunca falha o ACK / efeito já commitado
      }
    }

    this.logger.info('inbound.message_processed', {
      messageId,
      kind: envelope.data.kind,
      transportMessageId: message.transportMessageId,
    });
    return 'processed';
  }

  private async releaseWithoutAck(
    message: ReceivedBusMessage,
    reason: string,
  ): Promise<void> {
    if (this.bus.changeVisibility) {
      try {
        await this.bus.changeVisibility(message.receiptHandle, 0);
        this.logger.info('inbound.visibility_zero', {
          transportMessageId: message.transportMessageId,
          reason,
        });
      } catch {
        // VT original
      }
    }
  }
}

export function parseRequestedEnvelope(
  body: string,
): WagerTransactionRequestedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('mensagem inválida: JSON malformado');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('mensagem inválida: envelope ausente');
  }

  const env = parsed as Record<string, unknown>;
  if (env.type !== 'WagerTransactionRequested') {
    throw new Error(`mensagem inválida: type=${String(env.type)}`);
  }
  if (typeof env.messageId !== 'string' || env.messageId.trim() === '') {
    throw new Error('mensagem inválida: messageId obrigatório');
  }
  if (!env.data || typeof env.data !== 'object') {
    throw new Error('mensagem inválida: data ausente');
  }

  const data = env.data as Record<string, unknown>;
  const required = [
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
    'kind',
  ] as const;
  for (const key of required) {
    if (typeof data[key] !== 'string' || (data[key] as string).trim() === '') {
      throw new Error(`mensagem inválida: data.${key}`);
    }
  }

  const kind = data.kind as string;
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(kind)) {
    throw new Error(`mensagem inválida: kind=${kind}`);
  }

  if (kind === 'REFUND' || kind === 'ROLLBACK') {
    if (
      typeof data.referenceExternalTransactionId !== 'string' ||
      data.referenceExternalTransactionId.trim() === ''
    ) {
      throw new Error(
        'mensagem inválida: referenceExternalTransactionId obrigatório',
      );
    }
  }

  return env as unknown as WagerTransactionRequestedEnvelope;
}

function assertMoneyProps(money: unknown): void {
  if (!money || typeof money !== 'object') {
    throw new Error('mensagem inválida: money ausente');
  }
  const m = money as { amount?: unknown; currency?: unknown };
  if (typeof m.amount !== 'string') {
    throw new Error('mensagem inválida: money.amount deve ser string');
  }
  if (typeof m.currency !== 'string') {
    throw new Error('mensagem inválida: money.currency deve ser string');
  }
  // Money.from rejeita number/escala inválida — sem JavaScript number
  Money.from({ amount: m.amount, currency: m.currency });
}

function toSubmitInput(
  envelope: WagerTransactionRequestedEnvelope,
): SubmitWagerTransactionInput {
  const { data } = envelope;
  return {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    idempotencyKey: data.idempotencyKey,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: {
      amount: data.money.amount,
      currency: data.money.currency,
    },
    referenceExternalTransactionId: data.referenceExternalTransactionId,
  };
}
