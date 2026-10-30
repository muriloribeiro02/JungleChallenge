import type { OutboxMessage } from '../../domain/outbox/outbox-message.entity';
import { shouldRequireOutboxIntervention } from '../../domain/outbox/outbox-intervention.policy';
import type { MessageBus } from '../ports/message-bus';
import { noopMetrics, type MetricsPort } from '../ports/metrics';
import type { MessagingLogger } from '../ports/messaging-logger';
import type { UnitOfWork } from '../ports/unit-of-work';
import { sanitizeOperationalError } from './sanitize-operational-error';
import { shutdownGate } from './shutdown-gate';
import { applyShutdownTestHoldIfConfigured } from './shutdown-test-hold';

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
 * A partir de 10 attempts (ver política), exige intervenção manual —
 * sem descartar o evento e sem marcar published em falha.
 *
 * `attempts` é incrementado no claim e pode incluir claims abandonados
 * (crash/shutdown), não apenas falhas confirmadas de publicação.
 */
export class OutboxPublisher {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly bus: MessageBus,
    private readonly logger: MessagingLogger,
    private readonly options: OutboxPublisherOptions,
    private readonly metrics: MetricsPort = noopMetrics,
  ) {}

  async publishBatch(): Promise<{ claimed: number; published: number; failed: number }> {
    const claimed = await this.claim();
    // Probe C3: hold após claim (lease ativo), antes do publish/markPublished.
    await applyShutdownTestHoldIfConfigured();

    if (shutdownGate.abandonInFlight) {
      // Abandona o batch claimado — locked_until expira; outro publisher recupera.
      this.logger.info('outbox.batch_abandoned_shutdown', {
        claimed: claimed.length,
      });
      return { claimed: claimed.length, published: 0, failed: 0 };
    }

    let published = 0;
    let failed = 0;

    for (const message of claimed) {
      if (shutdownGate.abandonInFlight) {
        break;
      }

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

        if (shutdownGate.abandonInFlight) {
          // Publicado no bus mas sem markPublished — at-least-once na recuperação.
          failed += 1;
          break;
        }

        await this.markPublished(message.id);
        published += 1;
        const lagSeconds =
          (Date.now() - message.occurredAt.getTime()) / 1000;
        if (Number.isFinite(lagSeconds) && lagSeconds >= 0) {
          this.metrics.observeOutboxPublishLag(lagSeconds);
        }

        this.logger.info('outbox.event_published', {
          eventId: message.id,
          eventType: message.eventType,
          correlationId,
        });
      } catch (error) {
        failed += 1;
        const sanitized = sanitizeOperationalError(error);

        if (shouldRequireOutboxIntervention(message.attempts)) {
          const newlyRequired = await this.markInterventionRequired(
            message.id,
            sanitized,
          );

          this.logger.error('outbox.publish_failed', {
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            interventionRequired: true,
            error: sanitized,
            correlationId,
          });

          if (newlyRequired) {
            this.logger.error('outbox.intervention_required', {
              eventId: message.id,
              eventType: message.eventType,
              attempts: message.attempts,
              error: sanitized,
              correlationId,
            });
          }
        } else {
          const nextAttemptAt = computeNextAttemptAt(message.attempts);
          await this.markFailed(message.id, nextAttemptAt, sanitized);

          this.logger.error('outbox.publish_failed', {
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            nextAttemptAt: nextAttemptAt.toISOString(),
            interventionRequired: false,
            error: sanitized,
            correlationId,
          });
        }
      }
    }

    if (published > 0) {
      this.metrics.recordOutboxPublished(published);
    }
    if (failed > 0) {
      this.metrics.recordOutboxPublishFailed(failed);
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

  private async markFailed(
    id: string,
    nextAttemptAt: Date,
    lastError: string,
  ): Promise<void> {
    await this.unitOfWork.run((repos) =>
      repos.outboxMessages.markPublishFailed(id, nextAttemptAt, lastError),
    );
  }

  private async markInterventionRequired(
    id: string,
    lastError: string,
  ): Promise<boolean> {
    return this.unitOfWork.run((repos) =>
      repos.outboxMessages.markInterventionRequired(id, lastError),
    );
  }
}

export function computeNextAttemptAt(attempts: number, now = new Date()): Date {
  const delaySeconds = Math.min(300, 2 ** Math.max(1, attempts));
  return new Date(now.getTime() + delaySeconds * 1000);
}
