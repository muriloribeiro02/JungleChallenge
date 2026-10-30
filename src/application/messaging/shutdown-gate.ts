/**
 * Coordenação de graceful shutdown entre Host e consumers (composition root).
 * Sem DI circular: Host marca; Inbox/Inbound/Outbox consultam.
 */
export type ShutdownGateState = {
  /** Novos ticks e novas mensagens do batch não devem começar. */
  stopping: boolean;
  /**
   * Drain expirou: in-flight deve abandonar sem ACK.
   * Permite ChangeMessageVisibility(0) sem corrida com ACK posterior.
   */
  abandonInFlight: boolean;
};

export const shutdownGate: ShutdownGateState = {
  stopping: false,
  abandonInFlight: false,
};

export function markShutdownStopping(): void {
  shutdownGate.stopping = true;
}

export function markShutdownAbandonInFlight(): void {
  shutdownGate.abandonInFlight = true;
  shutdownGate.stopping = true;
}

/** Só para testes unitários. */
export function resetShutdownGate(): void {
  shutdownGate.stopping = false;
  shutdownGate.abandonInFlight = false;
}
