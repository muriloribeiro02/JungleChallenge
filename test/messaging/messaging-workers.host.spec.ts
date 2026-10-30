import { MessagingWorkersHost, workersEnabled } from '../../src/infrastructure/messaging/messaging-workers.host';

describe('MessagingWorkersHost', () => {
  const originalWorkers = process.env.WORKERS_ENABLED;
  const originalOutbox = process.env.WORKER_OUTBOX_INTERVAL_MS;
  const originalInbox = process.env.WORKER_INBOX_INTERVAL_MS;

  afterEach(() => {
    if (originalWorkers === undefined) {
      delete process.env.WORKERS_ENABLED;
    } else {
      process.env.WORKERS_ENABLED = originalWorkers;
    }
    if (originalOutbox === undefined) {
      delete process.env.WORKER_OUTBOX_INTERVAL_MS;
    } else {
      process.env.WORKER_OUTBOX_INTERVAL_MS = originalOutbox;
    }
    if (originalInbox === undefined) {
      delete process.env.WORKER_INBOX_INTERVAL_MS;
    } else {
      process.env.WORKER_INBOX_INTERVAL_MS = originalInbox;
    }
    jest.useRealTimers();
  });

  it('workersEnabled só é true com WORKERS_ENABLED=true', () => {
    process.env.WORKERS_ENABLED = 'false';
    expect(workersEnabled()).toBe(false);
    process.env.WORKERS_ENABLED = 'true';
    expect(workersEnabled()).toBe(true);
  });

  it('com workers desabilitados não agenda timers', () => {
    process.env.WORKERS_ENABLED = 'false';
    const publishBatch = jest.fn();
    const pollOnce = jest.fn();
    const host = new MessagingWorkersHost({
      outboxPublisher: { publishBatch },
      inboxConsumer: { pollOnce },
      inboundWagerConsumer: { pollOnce: jest.fn() },
    } as never);

    host.onModuleInit();
    host.onModuleDestroy();

    expect(publishBatch).not.toHaveBeenCalled();
    expect(pollOnce).not.toHaveBeenCalled();
  });

  it('com workers habilitados dispara publishBatch, pollOnce e pending batch', async () => {
    jest.useFakeTimers();
    process.env.WORKERS_ENABLED = 'true';
    process.env.WORKER_OUTBOX_INTERVAL_MS = '100';
    process.env.WORKER_INBOX_INTERVAL_MS = '100';
    process.env.WORKER_INBOUND_INTERVAL_MS = '100';
    process.env.WORKER_PENDING_INTERVAL_MS = '100';

    const publishBatch = jest.fn().mockResolvedValue({
      claimed: 0,
      published: 0,
      failed: 0,
    });
    const pollOnce = jest.fn().mockResolvedValue({
      received: 0,
      processed: 0,
      duplicates: 0,
      failed: 0,
    });
    const inboundPoll = jest.fn().mockResolvedValue({
      received: 0,
      processed: 0,
      duplicates: 0,
      failed: 0,
    });
    const pendingBatch = jest.fn().mockResolvedValue({
      claimed: 0,
      processed: 0,
      rejected: 0,
      expired: 0,
      deferred: 0,
      skipped: 0,
    });

    const host = new MessagingWorkersHost({
      outboxPublisher: { publishBatch },
      inboxConsumer: { pollOnce },
      inboundWagerConsumer: { pollOnce: inboundPoll },
      processPendingReferences: { processBatch: pendingBatch },
    } as never);

    host.onModuleInit();
    await jest.advanceTimersByTimeAsync(250);
    host.onModuleDestroy();

    expect(publishBatch.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(pollOnce.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(inboundPoll.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(pendingBatch.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
