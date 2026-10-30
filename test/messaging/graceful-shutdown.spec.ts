import { resetShutdownGate } from '../../src/application/messaging/shutdown-gate';
import { clearTrackedSqsReceipts } from '../../src/application/messaging/active-sqs-receipts';
import {
  MessagingWorkersHost,
  shutdownDrainMs,
  waitForInFlight,
} from '../../src/infrastructure/messaging/messaging-workers.host';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Graceful shutdown (C3) — MessagingWorkersHost', () => {
  const envKeys = [
    'WORKERS_ENABLED',
    'WORKER_OUTBOX_INTERVAL_MS',
    'WORKER_INBOX_INTERVAL_MS',
    'WORKER_INBOUND_INTERVAL_MS',
    'WORKER_PENDING_INTERVAL_MS',
    'SHUTDOWN_DRAIN_MS',
    'SHUTDOWN_TEST_HOLD_MS',
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      original[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
    resetShutdownGate();
    clearTrackedSqsReceipts();
    jest.useRealTimers();
  });

  function makeHost(overrides: {
    publishBatch?: jest.Mock;
    inboxPoll?: jest.Mock;
    inboundPoll?: jest.Mock;
    pendingBatch?: jest.Mock;
  }) {
    return new MessagingWorkersHost({
      outboxPublisher: {
        publishBatch:
          overrides.publishBatch ??
          jest.fn().mockResolvedValue({ claimed: 0, published: 0, failed: 0 }),
      },
      inboxConsumer: {
        pollOnce:
          overrides.inboxPoll ??
          jest.fn().mockResolvedValue({
            received: 0,
            processed: 0,
            duplicates: 0,
            failed: 0,
          }),
      },
      inboundWagerConsumer: {
        pollOnce:
          overrides.inboundPoll ??
          jest.fn().mockResolvedValue({
            received: 0,
            processed: 0,
            duplicates: 0,
            failed: 0,
          }),
      },
      processPendingReferences: {
        processBatch:
          overrides.pendingBatch ??
          jest.fn().mockResolvedValue({
            claimed: 0,
            processed: 0,
            rejected: 0,
            expired: 0,
            deferred: 0,
            skipped: 0,
          }),
      },
    } as never);
  }

  it('shutdownDrainMs lê SHUTDOWN_DRAIN_MS', () => {
    process.env.SHUTDOWN_DRAIN_MS = '2500';
    expect(shutdownDrainMs()).toBe(2500);
  });

  it('SHUTDOWN_TEST_HOLD_MS ausente/0/positivo: onModuleInit ok sem timers se workers off', () => {
    process.env.WORKERS_ENABLED = 'false';
    delete process.env.SHUTDOWN_TEST_HOLD_MS;
    const publishBatch = jest.fn();
    const hostAbsent = makeHost({ publishBatch });
    expect(() => hostAbsent.onModuleInit()).not.toThrow();
    hostAbsent.onModuleDestroy();

    process.env.SHUTDOWN_TEST_HOLD_MS = '0';
    const hostZero = makeHost({ publishBatch });
    expect(() => hostZero.onModuleInit()).not.toThrow();
    hostZero.onModuleDestroy();

    process.env.SHUTDOWN_TEST_HOLD_MS = '40';
    const hostPos = makeHost({ publishBatch });
    expect(() => hostPos.onModuleInit()).not.toThrow();
    hostPos.onModuleDestroy();

    expect(publishBatch).not.toHaveBeenCalled();
  });

  it('SHUTDOWN_TEST_HOLD_MS inválido: onModuleInit falha antes de timers/processamento', async () => {
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '15';
    process.env.WORKER_INBOX_INTERVAL_MS = '15';
    process.env.WORKER_INBOUND_INTERVAL_MS = '15';
    process.env.WORKER_PENDING_INTERVAL_MS = '15';
    process.env.SHUTDOWN_TEST_HOLD_MS = '-1';

    const publishBatch = jest.fn().mockResolvedValue({
      claimed: 0,
      published: 0,
      failed: 0,
    });
    const inboxPoll = jest.fn().mockResolvedValue({
      received: 0,
      processed: 0,
      duplicates: 0,
      failed: 0,
    });
    const host = makeHost({ publishBatch, inboxPoll });

    expect(() => host.onModuleInit()).toThrow(/SHUTDOWN_TEST_HOLD_MS/);
    await new Promise((r) => setTimeout(r, 50));
    expect(publishBatch).not.toHaveBeenCalled();
    expect(inboxPoll).not.toHaveBeenCalled();

    process.env.SHUTDOWN_TEST_HOLD_MS = 'abc';
    const hostText = makeHost({ publishBatch, inboxPoll });
    expect(() => hostText.onModuleInit()).toThrow(/SHUTDOWN_TEST_HOLD_MS/);
    await new Promise((r) => setTimeout(r, 50));
    expect(publishBatch).not.toHaveBeenCalled();
    expect(inboxPoll).not.toHaveBeenCalled();
  });

  it('A) SIGTERM com workers ociosos — drain imediato, sem novo poll', async () => {
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '50';
    process.env.WORKER_INBOX_INTERVAL_MS = '50';
    process.env.WORKER_INBOUND_INTERVAL_MS = '50';
    process.env.WORKER_PENDING_INTERVAL_MS = '50';

    const publishBatch = jest.fn().mockResolvedValue({
      claimed: 0,
      published: 0,
      failed: 0,
    });
    const host = makeHost({ publishBatch });
    host.onModuleInit();

    await host.beforeApplicationShutdown('SIGTERM');
    expect(host.isStopping).toBe(true);
    expect(host.inFlightCount).toBe(0);

    const callsAfter = publishBatch.mock.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(publishBatch.mock.calls.length).toBe(callsAfter);
    host.onModuleDestroy();
  });

  it('B) SIGTERM durante Outbox — aguarda publishBatch terminar', async () => {
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '20';
    process.env.WORKER_INBOX_INTERVAL_MS = '60000';
    process.env.WORKER_INBOUND_INTERVAL_MS = '60000';
    process.env.WORKER_PENDING_INTERVAL_MS = '60000';
    process.env.SHUTDOWN_DRAIN_MS = '5000';

    const gate = deferred();
    let started = false;
    const publishBatch = jest.fn().mockImplementation(async () => {
      started = true;
      await gate.promise;
      return { claimed: 1, published: 1, failed: 0 };
    });

    const host = makeHost({ publishBatch });
    host.onModuleInit();

    await waitUntil(() => started, 2000);
    const shutdown = host.beforeApplicationShutdown('SIGTERM');
    expect(host.isStopping).toBe(true);

    await new Promise((r) => setTimeout(r, 30));
    expect(host.inFlightCount).toBeGreaterThanOrEqual(1);

    gate.resolve();
    await shutdown;
    expect(host.inFlightCount).toBe(0);
    expect(publishBatch).toHaveBeenCalled();
    host.onModuleDestroy();
  });

  it('C) SIGTERM durante inbound — aguarda pollOnce', async () => {
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '60000';
    process.env.WORKER_INBOX_INTERVAL_MS = '60000';
    process.env.WORKER_INBOUND_INTERVAL_MS = '20';
    process.env.WORKER_PENDING_INTERVAL_MS = '60000';
    process.env.SHUTDOWN_DRAIN_MS = '5000';

    const gate = deferred();
    let started = false;
    const inboundPoll = jest.fn().mockImplementation(async () => {
      started = true;
      await gate.promise;
      return { received: 1, processed: 1, duplicates: 0, failed: 0 };
    });

    const host = makeHost({ inboundPoll });
    host.onModuleInit();
    await waitUntil(() => started, 2000);

    const shutdown = host.beforeApplicationShutdown('SIGINT');
    gate.resolve();
    await shutdown;
    expect(inboundPoll).toHaveBeenCalled();
    expect(host.inFlightCount).toBe(0);
    host.onModuleDestroy();
  });

  it('D) SIGTERM durante Inbox de eventos — aguarda pollOnce', async () => {
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '60000';
    process.env.WORKER_INBOX_INTERVAL_MS = '20';
    process.env.WORKER_INBOUND_INTERVAL_MS = '60000';
    process.env.WORKER_PENDING_INTERVAL_MS = '60000';
    process.env.SHUTDOWN_DRAIN_MS = '5000';

    const gate = deferred();
    let started = false;
    const inboxPoll = jest.fn().mockImplementation(async () => {
      started = true;
      await gate.promise;
      return { received: 1, processed: 1, duplicates: 0, failed: 0 };
    });

    const host = makeHost({ inboxPoll });
    host.onModuleInit();
    await waitUntil(() => started, 2000);

    const shutdown = host.beforeApplicationShutdown('SIGTERM');
    gate.resolve();
    await shutdown;
    expect(inboxPoll).toHaveBeenCalled();
    host.onModuleDestroy();
  });

  it('E) SIGTERM durante pendências — aguarda processBatch', async () => {
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '60000';
    process.env.WORKER_INBOX_INTERVAL_MS = '60000';
    process.env.WORKER_INBOUND_INTERVAL_MS = '60000';
    process.env.WORKER_PENDING_INTERVAL_MS = '20';
    process.env.SHUTDOWN_DRAIN_MS = '5000';

    const gate = deferred();
    let started = false;
    const pendingBatch = jest.fn().mockImplementation(async () => {
      started = true;
      await gate.promise;
      return {
        claimed: 1,
        processed: 0,
        rejected: 1,
        expired: 1,
        deferred: 0,
        skipped: 0,
      };
    });

    const host = makeHost({ pendingBatch });
    host.onModuleInit();
    await waitUntil(() => started, 2000);

    const shutdown = host.beforeApplicationShutdown('SIGTERM');
    gate.resolve();
    await shutdown;
    expect(pendingBatch).toHaveBeenCalled();
    host.onModuleDestroy();
  });

  it('F) timeout de drenagem excedido — retorna sem esperar o tick eterno', async () => {
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '20';
    process.env.WORKER_INBOX_INTERVAL_MS = '60000';
    process.env.WORKER_INBOUND_INTERVAL_MS = '60000';
    process.env.WORKER_PENDING_INTERVAL_MS = '60000';
    process.env.SHUTDOWN_DRAIN_MS = '80';

    const gate = deferred();
    let started = false;
    const publishBatch = jest.fn().mockImplementation(async () => {
      started = true;
      await gate.promise;
      return { claimed: 0, published: 0, failed: 0 };
    });

    const host = makeHost({ publishBatch });
    host.onModuleInit();
    await waitUntil(() => started, 2000);

    const startedAt = Date.now();
    await host.beforeApplicationShutdown('SIGTERM');
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(1500);
    expect(host.isStopping).toBe(true);

    gate.resolve();
    await publishBatch.mock.results[0]?.value;
    host.onModuleDestroy();
  });

  it('waitForInFlight: true quando vazio; false no timeout', async () => {
    expect(await waitForInFlight(new Set(), 50)).toBe(true);

    const gate = deferred();
    const set = new Set<Promise<unknown>>([gate.promise]);
    const result = waitForInFlight(set, 40);
    await expect(result).resolves.toBe(false);
    gate.resolve();
  });

  it('após stopping, tick não inicia novo ciclo mesmo com timer residual', async () => {
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '15';
    process.env.WORKER_INBOX_INTERVAL_MS = '60000';
    process.env.WORKER_INBOUND_INTERVAL_MS = '60000';
    process.env.WORKER_PENDING_INTERVAL_MS = '60000';

    const publishBatch = jest.fn().mockResolvedValue({
      claimed: 0,
      published: 0,
      failed: 0,
    });
    const host = makeHost({ publishBatch });
    host.onModuleInit();
    await new Promise((r) => setTimeout(r, 40));
    const before = publishBatch.mock.calls.length;
    await host.beforeApplicationShutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 80));
    expect(publishBatch.mock.calls.length).toBe(before);
    host.onModuleDestroy();
  });
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timeout waitUntil ${timeoutMs}ms`);
}
