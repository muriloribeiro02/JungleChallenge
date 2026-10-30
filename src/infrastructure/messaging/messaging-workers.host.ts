import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  APP_COMPOSITION,
  type AppCompositionToken,
} from '../../composition/tokens';

/**
 * Loops de Outbox Publisher e Inbox Consumer por processo.
 * Flag WORKERS_ENABLED (default false em dev local; true nos containers app-*).
 * Não altera regras financeiras — só dispara publishBatch / pollOnce.
 */
@Injectable()
export class MessagingWorkersHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessagingWorkersHost.name);
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private inboxTimer: ReturnType<typeof setInterval> | null = null;
  private outboxRunning = false;
  private inboxRunning = false;
  private stopped = false;

  constructor(
    @Inject(APP_COMPOSITION) private readonly app: AppCompositionToken,
  ) {}

  onModuleInit(): void {
    if (!workersEnabled()) {
      this.logger.log('Workers desabilitados (WORKERS_ENABLED≠true)');
      return;
    }

    const outboxMs = positiveInt(
      process.env.WORKER_OUTBOX_INTERVAL_MS,
      500,
    );
    const inboxMs = positiveInt(process.env.WORKER_INBOX_INTERVAL_MS, 500);
    const instanceId = process.env.INSTANCE_ID ?? `pid-${process.pid}`;

    this.logger.log(
      `Workers ativos instance=${instanceId} outboxEvery=${outboxMs}ms inboxEvery=${inboxMs}ms`,
    );

    this.outboxTimer = setInterval(() => {
      void this.tickOutbox();
    }, outboxMs);

    this.inboxTimer = setInterval(() => {
      void this.tickInbox();
    }, inboxMs);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.inboxTimer) {
      clearInterval(this.inboxTimer);
      this.inboxTimer = null;
    }
  }

  private async tickOutbox(): Promise<void> {
    if (this.stopped || this.outboxRunning) {
      return;
    }
    this.outboxRunning = true;
    try {
      await this.app.outboxPublisher.publishBatch();
    } catch (error) {
      this.logger.error(
        `outbox tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.outboxRunning = false;
    }
  }

  private async tickInbox(): Promise<void> {
    if (this.stopped || this.inboxRunning) {
      return;
    }
    this.inboxRunning = true;
    try {
      await this.app.inboxConsumer.pollOnce();
    } catch (error) {
      this.logger.error(
        `inbox tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.inboxRunning = false;
    }
  }
}

export function workersEnabled(): boolean {
  return (process.env.WORKERS_ENABLED ?? 'false').toLowerCase() === 'true';
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
