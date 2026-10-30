import type { OutboxMessage } from './outbox-message.entity';

export interface OutboxMessageRepository {
  save(message: OutboxMessage): Promise<void>;
  findByAggregateId(aggregateId: string): Promise<OutboxMessage[]>;
  findById(id: string): Promise<OutboxMessage | null>;
  /**
   * Reserva até `limit` mensagens publicáveis com FOR UPDATE SKIP LOCKED.
   * Incrementa `attempts` e define `locked_until`.
   *
   * Exclui: publicados, lease ativo, next_attempt_at futuro, e
   * `intervention_required_at` preenchido.
   *
   * Nota: `attempts` inclui claims abandonados (crash/shutdown), não só
   * falhas confirmadas de publicação.
   */
  claimUnpublished(limit: number, leaseSeconds: number): Promise<OutboxMessage[]>;
  markPublished(id: string, publishedAt?: Date): Promise<void>;
  markPublishFailed(
    id: string,
    nextAttemptAt: Date,
    lastError?: string | null,
  ): Promise<void>;
  /**
   * Transição atômica para intervenção. Retorna true somente se esta chamada
   * foi a que definiu `intervention_required_at` (uma vez por evento).
   */
  markInterventionRequired(id: string, lastError: string): Promise<boolean>;
  /**
   * Libera pausa operacional. Retorna true se o evento estava em intervenção
   * e foi liberado. Não reseta `attempts`; preserva payload/eventId.
   */
  clearIntervention(id: string, nextAttemptAt?: Date): Promise<boolean>;
}

export const OUTBOX_MESSAGE_REPOSITORY = Symbol('OUTBOX_MESSAGE_REPOSITORY');
