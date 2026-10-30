import type { DataSource } from 'typeorm';
import type { OutboxMessage } from '../../domain/outbox/outbox-message.entity';
import { TypeOrmOutboxMessageRepository } from '../../infrastructure/repository/outbox/typeorm-outbox-message.repository';
import { OutboxMessageOrmEntity } from '../../infrastructure/repository/outbox/outbox-message.orm-entity';
import { sqsEnv } from '../../infrastructure/messaging/sqs.env';
import type { MessageBus } from './message-bus';
import {
  ConsoleMessagingLogger,
  type MessagingLogger,
} from './messaging-logger';

/**
 * Publica eventos da outbox no MessageBus (SQS).
 *
 * Fluxo: claim (SKIP LOCKED) → publish → markPublished.
 * Se o SQS aceitar e o mark falhar, redelivery publica de novo (at-least-once);
 * a Inbox no consumer evita efeitos duplicados.
 *
 * Decisão: backoff next_attempt_at = min(300, 2^attempts) segundos.
 */
export class OutboxPublisher {
  constructor(
    private readonly dataSource: DataSource,
    private readonly bus: MessageBus,
    private readonly logger: MessagingLogger = new ConsoleMessagingLogger(),
    private readonly batchSize = sqsEnv.publisherBatchSize,
    private readonly leaseSeconds = sqsEnv.claimLeaseSeconds,
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
    return this.dataSource.transaction(async (manager) => {
      const repo = new TypeOrmOutboxMessageRepository(
        manager.getRepository(OutboxMessageOrmEntity),
        manager,
      );
      return repo.claimUnpublished(this.batchSize, this.leaseSeconds);
    });
  }

  private async markPublished(id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = new TypeOrmOutboxMessageRepository(
        manager.getRepository(OutboxMessageOrmEntity),
        manager,
      );
      await repo.markPublished(id);
    });
  }

  private async markFailed(id: string, nextAttemptAt: Date): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = new TypeOrmOutboxMessageRepository(
        manager.getRepository(OutboxMessageOrmEntity),
        manager,
      );
      await repo.markPublishFailed(id, nextAttemptAt);
    });
  }
}

export function computeNextAttemptAt(attempts: number, now = new Date()): Date {
  const delaySeconds = Math.min(300, 2 ** Math.max(1, attempts));
  return new Date(now.getTime() + delaySeconds * 1000);
}
