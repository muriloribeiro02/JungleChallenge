import {
  InboxMessage,
  INBOX_CONSUMER_DOMAIN_EVENTS,
} from '../../domain/inbox/inbox-message.entity';
import type { DomainEventEnvelope } from '../../domain/events/domain-event';
import type { MessageBus, ReceivedBusMessage } from '../ports/message-bus';
import type { MessagingLogger } from '../ports/messaging-logger';
import type { UnitOfWork } from '../ports/unit-of-work';
import {
  trackSqsReceipt,
  untrackSqsReceipt,
} from './active-sqs-receipts';
import type { DomainEventHandler } from './domain-event-handler';
import { shutdownGate } from './shutdown-gate';
import { applyShutdownTestHoldIfConfigured } from './shutdown-test-hold';

export type InboxConsumerOptions = {
  maxMessages: number;
  waitSeconds: number;
};

/**
 * Consome mensagens do MessageBus com deduplicação via Inbox (mesma TX do efeito).
 * ACK somente após commit bem-sucedido.
 *
 * - Falha antes do commit → sem ACK → redelivery.
 * - Falha após commit e antes do ACK → redelivery → Inbox detecta duplicata → ACK sem reprocessar.
 * - Rejeição de negócio no use case é sucesso de mensageria (já persistida).
 * - maxReceiveCount / DLQ ficam a cargo do transporte (ex.: SQS).
 */
export class InboxConsumer {
  constructor(
    private readonly bus: MessageBus,
    private readonly unitOfWork: UnitOfWork,
    private readonly handler: DomainEventHandler,
    private readonly logger: MessagingLogger,
    private readonly options: InboxConsumerOptions,
  ) {}

  async pollOnce(): Promise<{
    received: number;
    processed: number;
    duplicates: number;
    failed: number;
  }> {
    const messages = await this.bus.receive(
      this.options.maxMessages,
      this.options.waitSeconds,
    );
    let processed = 0;
    let duplicates = 0;
    let failed = 0;

    for (const message of messages) {
      if (shutdownGate.stopping || shutdownGate.abandonInFlight) {
        await this.releaseWithoutAck(message, 'shutdown_before_start');
        failed += 1;
        continue;
      }

      const receiptKey = `inbox:${message.transportMessageId}:${message.receiptHandle}`;
      trackSqsReceipt(
        receiptKey,
        this.bus,
        message.receiptHandle,
        message.transportMessageId,
      );

      try {
        // Probe C3 (só com SHUTDOWN_TEST_HOLD_MS): hold após receive, antes do UoW.
        await applyShutdownTestHoldIfConfigured();

        if (shutdownGate.abandonInFlight) {
          await this.releaseWithoutAck(message, 'shutdown_abandon');
          untrackSqsReceipt(receiptKey);
          failed += 1;
          continue;
        }

        const outcome = await this.consumeOne(message);

        if (shutdownGate.abandonInFlight) {
          // UoW pode ter commitado — sem ACK; redelivery → Inbox dedupe.
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
        // visibility=0 após falha técnica / abandon — best-effort.
        await this.releaseWithoutAck(message, 'error');
        this.logger.error('inbox.message_failed', {
          transportMessageId: message.transportMessageId,
          receiveCount: message.receiveCount,
          error: error instanceof Error ? error.message : String(error),
          willRetryOrDlq: true,
        });
        this.logger.info('inbox.message_retry', {
          transportMessageId: message.transportMessageId,
          receiveCount: message.receiveCount,
        });
      }
    }

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
    const envelope = parseEnvelope(message.body);
    const eventId = envelope.eventId || message.id;

    this.logger.info('inbox.message_received', {
      eventId,
      eventType: envelope.eventType,
      transportMessageId: message.transportMessageId,
      receiveCount: message.receiveCount,
      correlationId: envelope.correlationId,
    });

    const inserted = await this.unitOfWork.run(async (repos) => {
      const first = await repos.inboxMessages.tryInsert(
        InboxMessage.record({
          id: eventId,
          consumerName: INBOX_CONSUMER_DOMAIN_EVENTS,
          eventType: envelope.eventType,
          transportMessageId: message.transportMessageId,
        }),
      );

      if (!first) {
        return false;
      }

      await this.handler.handleWithRepos(envelope, repos);
      return true;
    });

    if (!inserted) {
      this.logger.info('inbox.message_duplicate', {
        eventId,
        eventType: envelope.eventType,
        transportMessageId: message.transportMessageId,
        correlationId: envelope.correlationId,
      });
      return 'duplicate';
    }

    this.logger.info('inbox.message_processed', {
      eventId,
      eventType: envelope.eventType,
      transportMessageId: message.transportMessageId,
      correlationId: envelope.correlationId,
    });

    return 'processed';
  }

  private async releaseWithoutAck(
    message: ReceivedBusMessage,
    reason: string,
  ): Promise<void> {
    // Nunca ACK aqui — só devolve à fila o mais cedo possível (best-effort).
    if (this.bus.changeVisibility) {
      try {
        await this.bus.changeVisibility(message.receiptHandle, 0);
        this.logger.info('inbox.visibility_zero', {
          transportMessageId: message.transportMessageId,
          reason,
        });
      } catch {
        // VT original; redelivery após visibility timeout.
      }
    }
  }
}

function parseEnvelope(body: string): DomainEventEnvelope {
  const parsed = JSON.parse(body) as DomainEventEnvelope;
  if (!parsed || typeof parsed !== 'object' || !parsed.eventType) {
    throw new Error('mensagem inválida: envelope ausente');
  }
  return parsed;
}
