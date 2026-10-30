import type { OutboxMessage } from '../../domain/outbox/outbox-message.entity';
import type { MessageBus } from '../ports/message-bus';
import type { MessagingLogger } from '../ports/messaging-logger';
import type { UnitOfWork } from '../ports/unit-of-work';

export type OutboxPublisherOptions = {
  batchSize: number;
  leaseSeconds: number;
};

/**
 * Publica eventos da outbox no MessageBus.
 *
 * Fluxo: claim → publish → markPublished.
 * Se o bus aceitar e o mark falhar, redelivery publica de novo (at-least-once);
 * a Inbox no consumer evita efeitos duplicados.
 *
 * Decisão: backoff next_attempt_at = min(300, 2^attempts) segundos.
 */
export class OutboxPublisher {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly bus: MessageBus,
    private readonly logger: MessagingLogger,
    private readonly options: OutboxPublisherOptions,
  ) {}

  async publishBatch(): Promise<{ claimed: number; published: number; failed: number }> {
    const claimed = await this.claim();
    let published = 0;
    let failed = 0;

    for (const message of claimed) {
      const correlationId = message.payload?.correlationId;

      this.logger.info('outbox.event_reserved', {
        eventId: message.id,
        eventType: message.eventType,
        attempts: message.attempts,
        correlationId,
      });

      try {
        await this.bus.publish({
          id: message.id,
          body: JSON.stringify(message.payload),
          attributes: {
            eventType: message.eventType,
            ...(correlationId ? { correlationId } : {}),
          },
        });

        await this.markPublished(message.id);
        published += 1;

        this.logger.info('outbox.event_published', {
          eventId: message.id,
          eventType: message.eventType,
          correlationId,
        });
      } catch (error) {
        failed += 1;
        const nextAttemptAt = computeNextAttemptAt(message.attempts);
        await this.markFailed(message.id, nextAttemptAt);

        this.logger.error('outbox.publish_failed', {
          eventId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
          nextAttemptAt: nextAttemptAt.toISOString(),
          error: error instanceof Error ? error.message : String(error),
          correlationId,
        });
      }
    }

    return { claimed: claimed.length, published, failed };
  }

  private async claim(): Promise<OutboxMessage[]> {
    return this.unitOfWork.run((repos) =>
      repos.outboxMessages.claimUnpublished(
        this.options.batchSize,
        this.options.leaseSeconds,
      ),
    );
  }

  private async markPublished(id: string): Promise<void> {
    await this.unitOfWork.run((repos) => repos.outboxMessages.markPublished(id));
  }

  private async markFailed(id: string, nextAttemptAt: Date): Promise<void> {
    await this.unitOfWork.run((repos) =>
      repos.outboxMessages.markPublishFailed(id, nextAttemptAt),
    );
  }
}

export function computeNextAttemptAt(attempts: number, now = new Date()): Date {
  const delaySeconds = Math.min(300, 2 ** Math.max(1, attempts));
  return new Date(now.getTime() + delaySeconds * 1000);
}
