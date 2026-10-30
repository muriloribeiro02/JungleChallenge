import { InboxMessage } from '../../domain/inbox/inbox-message.entity';
import type { DomainEventEnvelope } from '../../domain/events/domain-event';
import type { MessageBus, ReceivedBusMessage } from '../ports/message-bus';
import type { MessagingLogger } from '../ports/messaging-logger';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { DomainEventHandler } from './domain-event-handler';

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
      try {
        const outcome = await this.consumeOne(message);
        if (outcome === 'duplicate') {
          duplicates += 1;
        } else {
          processed += 1;
        }
        await this.bus.ack(message.receiptHandle);
      } catch (error) {
        failed += 1;
        // Decisão: visibility=0 após falha técnica para redelivery imediata
        // (ApproximateReceiveCount / maxReceiveCount / DLQ continuam no transporte).
        if (this.bus.changeVisibility) {
          try {
            await this.bus.changeVisibility(message.receiptHandle, 0);
          } catch {
            // Mantém visibility original; próximo poll após VT.
          }
        }
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
}

function parseEnvelope(body: string): DomainEventEnvelope {
  const parsed = JSON.parse(body) as DomainEventEnvelope;
  if (!parsed || typeof parsed !== 'object' || !parsed.eventType) {
    throw new Error('mensagem inválida: envelope ausente');
  }
  return parsed;
}
