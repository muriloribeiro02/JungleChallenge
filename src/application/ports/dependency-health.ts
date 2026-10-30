/**
 * Porta de readiness: disponibilidade das dependências externas.
 * Implementação (TypeORM + MessageBus) fica na infrastructure.
 */
export type DependencyHealthSnapshot = {
  postgres: boolean;
  sqs: boolean;
};

export interface DependencyHealthPort {
  check(): Promise<DependencyHealthSnapshot>;
}

export const DEPENDENCY_HEALTH = Symbol('DEPENDENCY_HEALTH');
