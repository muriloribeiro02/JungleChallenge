import {
  OutboxEventAlreadyPublishedError,
  OutboxEventNotAwaitingInterventionError,
  OutboxEventNotFoundError,
} from '../../../domain/outbox/outbox-intervention.errors';
import type { MessagingLogger } from '../../ports/messaging-logger';
import type { UnitOfWork } from '../../ports/unit-of-work';

export type ClearOutboxInterventionInput = {
  eventId: string;
};

export type ClearOutboxInterventionResult = {
  eventId: string;
  attempts: number;
  eventType: string;
  nextAttemptAt: string;
};

/**
 * Recuperação operacional controlada de evento Outbox pausado.
 * Não exposto via HTTP público — use o CLI ops documentado no runbook.
 *
 * Preserva payload, eventId e attempts (sem reset automático).
 */
export class ClearOutboxInterventionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly logger: MessagingLogger,
  ) {}

  async execute(
    input: ClearOutboxInterventionInput,
  ): Promise<ClearOutboxInterventionResult> {
    const nextAttemptAt = new Date();

    const result = await this.unitOfWork.run(async (repos) => {
      const message = await repos.outboxMessages.findById(input.eventId);
      if (!message) {
        throw new OutboxEventNotFoundError(input.eventId);
      }
      if (message.isPublished) {
        throw new OutboxEventAlreadyPublishedError(input.eventId);
      }
      if (!message.requiresIntervention) {
        throw new OutboxEventNotAwaitingInterventionError(input.eventId);
      }

      const cleared = await repos.outboxMessages.clearIntervention(
        input.eventId,
        nextAttemptAt,
      );
      if (!cleared) {
        // Race: outra ops limpou; trate como já não aguarda intervenção.
        throw new OutboxEventNotAwaitingInterventionError(input.eventId);
      }

      return {
        eventId: message.id,
        attempts: message.attempts,
        eventType: message.eventType,
        nextAttemptAt: nextAttemptAt.toISOString(),
      };
    });

    this.logger.info('outbox.intervention_cleared', {
      eventId: result.eventId,
      eventType: result.eventType,
      attempts: result.attempts,
      nextAttemptAt: result.nextAttemptAt,
    });

    return result;
  }
}
