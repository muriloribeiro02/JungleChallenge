import { loadPendingReferenceWorkerEnv } from '../../src/infrastructure/config/pending-reference-worker.env';
import {
  positiveInt,
  shutdownDrainMs,
} from '../../src/infrastructure/messaging/messaging-workers.host';
import { shutdownTestHoldMs } from '../../src/application/messaging/shutdown-test-hold';

describe('pending / worker env numéricos', () => {
  const keys = [
    'PENDING_REFERENCE_BATCH_SIZE',
    'PENDING_REFERENCE_LEASE_SECONDS',
    'WORKER_PENDING_INTERVAL_MS',
    'SHUTDOWN_DRAIN_MS',
    'SHUTDOWN_TEST_HOLD_MS',
  ] as const;

  const snapshot: Partial<Record<(typeof keys)[number], string | undefined>> =
    {};

  beforeEach(() => {
    for (const k of keys) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      const v = snapshot[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it('PENDING: defaults do código batch=10 lease=30 quando ausente', () => {
    expect(loadPendingReferenceWorkerEnv({})).toEqual({
      batchSize: 10,
      leaseSeconds: 30,
    });
  });

  it('PENDING: aceita valores válidos', () => {
    expect(
      loadPendingReferenceWorkerEnv({
        PENDING_REFERENCE_BATCH_SIZE: '5',
        PENDING_REFERENCE_LEASE_SECONDS: '15',
      }),
    ).toEqual({ batchSize: 5, leaseSeconds: 15 });
  });

  it('PENDING: rejeita inválidos com nome da variável', () => {
    expect(() =>
      loadPendingReferenceWorkerEnv({ PENDING_REFERENCE_BATCH_SIZE: '0' }),
    ).toThrow(/PENDING_REFERENCE_BATCH_SIZE/);
    expect(() =>
      loadPendingReferenceWorkerEnv({
        PENDING_REFERENCE_LEASE_SECONDS: '1.5',
      }),
    ).toThrow(/PENDING_REFERENCE_LEASE_SECONDS/);
  });

  it('WORKER_PENDING_INTERVAL_MS: default 1000; rejeita zero/NaN', () => {
    expect(positiveInt('WORKER_PENDING_INTERVAL_MS', undefined, 1000)).toBe(
      1000,
    );
    expect(positiveInt('WORKER_PENDING_INTERVAL_MS', '300', 1000)).toBe(300);
    expect(() =>
      positiveInt('WORKER_PENDING_INTERVAL_MS', '0', 1000),
    ).toThrow(/WORKER_PENDING_INTERVAL_MS/);
    expect(() =>
      positiveInt('WORKER_PENDING_INTERVAL_MS', 'abc', 1000),
    ).toThrow(/WORKER_PENDING_INTERVAL_MS/);
  });

  it('SHUTDOWN_DRAIN_MS: default 10000; rejeita inválido', () => {
    expect(shutdownDrainMs()).toBe(10_000);
    process.env.SHUTDOWN_DRAIN_MS = '2500';
    expect(shutdownDrainMs()).toBe(2500);
    process.env.SHUTDOWN_DRAIN_MS = '-1';
    expect(() => shutdownDrainMs()).toThrow(/SHUTDOWN_DRAIN_MS/);
  });

  it('SHUTDOWN_TEST_HOLD_MS: default 0; aceita 0/positivo; rejeita negativo e texto', () => {
    expect(shutdownTestHoldMs({})).toBe(0);
    expect(shutdownTestHoldMs({ SHUTDOWN_TEST_HOLD_MS: '0' })).toBe(0);
    expect(shutdownTestHoldMs({ SHUTDOWN_TEST_HOLD_MS: '40' })).toBe(40);
    expect(() =>
      shutdownTestHoldMs({ SHUTDOWN_TEST_HOLD_MS: '-3' }),
    ).toThrow(/SHUTDOWN_TEST_HOLD_MS/);
    expect(() =>
      shutdownTestHoldMs({ SHUTDOWN_TEST_HOLD_MS: 'abc' }),
    ).toThrow(/SHUTDOWN_TEST_HOLD_MS/);
  });
});
