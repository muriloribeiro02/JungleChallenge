import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { releaseTrackedReceiptsBestEffort } from '../../application/messaging/active-sqs-receipts';
import {
  markShutdownAbandonInFlight,
  markShutdownStopping,
  resetShutdownGate,
} from '../../application/messaging/shutdown-gate';
import { shutdownTestHoldMs } from '../../application/messaging/shutdown-test-hold';
import {
  APP_COMPOSITION,
  type AppCompositionToken,
} from '../../composition/tokens';
import { optionalPositiveInt } from '../../shared/parse-env-int';

/**
 * Loops de Outbox / Inbox / Inbound / Pending por processo.
 *
 * Fase C3 — graceful shutdown:
 * 1. `stopped` impede novos ticks
 * 2. timers são limpos
 * 3. ticks já iniciados são aguardados até `SHUTDOWN_DRAIN_MS`
 * Limpar timer NÃO cancela trabalho em voo — só `await` do in-flight.
 */
@Injectable()
export class MessagingWorkersHost
  implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(MessagingWorkersHost.name);
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private inboxTimer: ReturnType<typeof setInterval> | null = null;
  private inboundTimer: ReturnType<typeof setInterval> | null = null;
  private pendingTimer: ReturnType<typeof setInterval> | null = null;
  private outboxRunning = false;
  private inboxRunning = false;
  private inboundRunning = false;
  private pendingRunning = false;
  private stopped = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(APP_COMPOSITION) private readonly app: AppCompositionToken,
  ) {}

  get isStopping(): boolean {
    return this.stopped;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  onModuleInit(): void {
    resetShutdownGate();
    this.stopped = false;

    // Valida intervalos/drain/hold na init (antes dos timers), mesmo com workers off.
    const outboxMs = positiveInt(
      'WORKER_OUTBOX_INTERVAL_MS',
      process.env.WORKER_OUTBOX_INTERVAL_MS,
      500,
    );
    const inboxMs = positiveInt(
      'WORKER_INBOX_INTERVAL_MS',
      process.env.WORKER_INBOX_INTERVAL_MS,
      500,
    );
    const inboundMs = positiveInt(
      'WORKER_INBOUND_INTERVAL_MS',
      process.env.WORKER_INBOUND_INTERVAL_MS,
      500,
    );
    const pendingMs = positiveInt(
      'WORKER_PENDING_INTERVAL_MS',
      process.env.WORKER_PENDING_INTERVAL_MS,
      1000,
    );
    void shutdownDrainMs();
    // Mesmo helper de applyShutdownTestHoldIfConfigured — falha cedo se inválido.
    void shutdownTestHoldMs();

    if (!workersEnabled()) {
      this.logger.log('Workers desabilitados (WORKERS_ENABLED≠true)');
      return;
    }

    const instanceId = process.env.INSTANCE_ID ?? `pid-${process.pid}`;

    this.logger.log(
      `Workers ativos instance=${instanceId} outboxEvery=${outboxMs}ms inboxEvery=${inboxMs}ms inboundEvery=${inboundMs}ms pendingEvery=${pendingMs}ms`,
    );

    this.outboxTimer = setInterval(() => {
      void this.tickOutbox();
    }, outboxMs);

    this.inboxTimer = setInterval(() => {
      void this.tickInbox();
    }, inboxMs);

    this.inboundTimer = setInterval(() => {
      void this.tickInbound();
    }, inboundMs);

    this.pendingTimer = setInterval(() => {
      void this.tickPending();
    }, pendingMs);
  }

  /**
   * Nest chama antes de `onModuleDestroy` (com `enableShutdownHooks`).
   * Drena ticks em andamento; DataSource só fecha depois (AppModule).
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (this.stopped && this.inFlight.size === 0) {
      return;
    }

    const instanceId = process.env.INSTANCE_ID ?? `pid-${process.pid}`;
    this.logger.log(
      `shutdown.start instance=${instanceId} signal=${signal ?? 'unknown'} inFlight=${this.inFlight.size}`,
    );

    this.stopped = true;
    markShutdownStopping();
    this.clearTimers();

    const drainMs = shutdownDrainMs();
    const drained = await waitForInFlight(this.inFlight, drainMs);

    if (drained) {
      this.logger.log(
        `shutdown.complete instance=${instanceId} drained=true inFlight=0`,
      );
    } else {
      // Abandona in-flight: sem ACK; VT=0 best-effort; outbox via lease.
      markShutdownAbandonInFlight();
      const released = await releaseTrackedReceiptsBestEffort({
        info: (event, fields) =>
          this.logger.log(`${event} ${JSON.stringify(fields ?? {})}`),
        warn: (event, fields) =>
          this.logger.warn(`${event} ${JSON.stringify(fields ?? {})}`),
        error: (event, fields) =>
          this.logger.error(`${event} ${JSON.stringify(fields ?? {})}`),
      });
      this.logger.warn(
        `shutdown.drain_timeout instance=${instanceId} limitMs=${drainMs} remainingInFlight=${this.inFlight.size} visibilityZero=${released}`,
      );
      this.logger.log(
        `shutdown.complete instance=${instanceId} drained=false inFlight=${this.inFlight.size}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    markShutdownStopping();
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.inboxTimer) {
      clearInterval(this.inboxTimer);
      this.inboxTimer = null;
    }
    if (this.inboundTimer) {
      clearInterval(this.inboundTimer);
      this.inboundTimer = null;
    }
    if (this.pendingTimer) {
      clearInterval(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => {
      this.inFlight.delete(work);
    });
  }

  private async tickOutbox(): Promise<void> {
    if (this.stopped || this.outboxRunning) {
      return;
    }
    this.outboxRunning = true;
    const work = (async () => {
      try {
        await this.app.outboxPublisher.publishBatch();
      } catch (error) {
        this.logger.error(
          `outbox tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.outboxRunning = false;
      }
    })();
    this.track(work);
    await work;
  }

  private async tickInbox(): Promise<void> {
    if (this.stopped || this.inboxRunning) {
      return;
    }
    this.inboxRunning = true;
    const work = (async () => {
      try {
        await this.app.inboxConsumer.pollOnce();
      } catch (error) {
        this.logger.error(
          `inbox tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.inboxRunning = false;
      }
    })();
    this.track(work);
    await work;
  }

  private async tickInbound(): Promise<void> {
    if (this.stopped || this.inboundRunning) {
      return;
    }
    this.inboundRunning = true;
    const work = (async () => {
      try {
        await this.app.inboundWagerConsumer.pollOnce();
      } catch (error) {
        this.logger.error(
          `inbound tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.inboundRunning = false;
      }
    })();
    this.track(work);
    await work;
  }

  private async tickPending(): Promise<void> {
    if (this.stopped || this.pendingRunning) {
      return;
    }
    this.pendingRunning = true;
    const work = (async () => {
      try {
        await this.app.processPendingReferences.processBatch();
      } catch (error) {
        this.logger.error(
          `pending tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.pendingRunning = false;
      }
    })();
    this.track(work);
    await work;
  }
}

export function workersEnabled(): boolean {
  return (process.env.WORKERS_ENABLED ?? 'false').toLowerCase() === 'true';
}

export function shutdownDrainMs(): number {
  return positiveInt('SHUTDOWN_DRAIN_MS', process.env.SHUTDOWN_DRAIN_MS, 10_000);
}

/** Aguarda promises em voo ou estoura o timeout. `true` = drenou tudo. */
export async function waitForInFlight(
  inFlight: ReadonlySet<Promise<unknown>>,
  timeoutMs: number,
): Promise<boolean> {
  if (inFlight.size === 0) {
    return true;
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
  return !timedOut;
}

export function positiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  return optionalPositiveInt(name, raw, fallback);
}
