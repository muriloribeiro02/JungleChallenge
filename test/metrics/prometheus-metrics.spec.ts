import { Registry } from 'prom-client';
import { createPrometheusMetrics } from '../../src/infrastructure/metrics/prometheus-metrics';
import { CachedValue } from '../../src/infrastructure/metrics/cached-value';
import { safeMetrics, noopMetrics } from '../../src/application/ports/metrics';

describe('PrometheusMetrics (unit)', () => {
  it('incrementa transações, replay e histogram sem IDs nos labels', async () => {
    const registry = new Registry();
    const metrics = createPrometheusMetrics({ registry, gaugeCacheTtlMs: 60_000 });

    metrics.recordWagerTransaction({
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: false,
      durationSeconds: 0.02,
    });
    metrics.recordWagerTransaction({
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: true,
      durationSeconds: 0.01,
    });
    metrics.recordWagerTransaction({
      kind: 'REFUND',
      status: 'PENDING_REFERENCE',
      idempotentReplay: false,
      durationSeconds: 0.05,
    });

    const body = await metrics.collect();
    expect(body).toContain('dwp_wager_transactions_total');
    expect(body).toMatch(
      /dwp_wager_transactions_total\{[^}]*kind="BET"[^}]*status="PROCESSED"[^}]*\} 2/,
    );
    expect(body).toContain('dwp_wager_idempotent_replays_total');
    expect(body).toContain('dwp_wager_transaction_duration_seconds');
    expect(body).not.toMatch(/walletId|transactionId|playerId/);
    expect(body).not.toMatch(/\b\d+\.\d{2}\b.*balance/i);
  });

  it('registra duplicidade, falha e retry de mensageria', async () => {
    const registry = new Registry();
    const metrics = createPrometheusMetrics({ registry });

    metrics.recordMessagingReceived('domain_events', 3);
    metrics.recordMessagingProcessed('domain_events', 1);
    metrics.recordMessagingDuplicate('domain_events', 1);
    metrics.recordMessagingFailed('domain_events', 1);
    metrics.recordMessagingRetry('domain_events', 2);
    metrics.setMessagingInFlight('domain_events', 1);
    metrics.observeMessagingDuration('domain_events', 0.1);

    const body = await metrics.collect();
    expect(body).toContain('dwp_messaging_messages_duplicate_total');
    expect(body).toContain('dwp_messaging_messages_failed_total');
    expect(body).toContain('dwp_messaging_retries_total');
    expect(body).toContain('consumer="domain_events"');
  });

  it('registra outbox publish/fail e lag', async () => {
    const registry = new Registry();
    const metrics = createPrometheusMetrics({ registry });

    metrics.recordOutboxPublished(2);
    metrics.recordOutboxPublishFailed(1);
    metrics.observeOutboxPublishLag(1.5);

    const body = await metrics.collect();
    expect(body).toMatch(/dwp_outbox_events_published_total(?:\{[^}]*\})? 2/);
    expect(body).toMatch(/dwp_outbox_events_publish_failures_total(?:\{[^}]*\})? 1/);
    expect(body).toContain('dwp_outbox_publish_lag_seconds');
  });

  it('registra reconciliação e pending reference', async () => {
    const registry = new Registry();
    const metrics = createPrometheusMetrics({ registry });

    metrics.recordReconciliation({ consistent: false, durationSeconds: 0.2 });
    metrics.recordPendingReferenceBatch({
      processed: 1,
      rejected: 2,
      expired: 1,
      deferred: 3,
    });
    metrics.recordLockConflict('idempotency_key');

    const body = await metrics.collect();
    expect(body).toMatch(/dwp_reconciliation_runs_total(?:\{[^}]*\})? 1/);
    expect(body).toMatch(/dwp_reconciliation_divergences_total(?:\{[^}]*\})? 1/);
    expect(body).toMatch(/dwp_pending_reference_expired_total(?:\{[^}]*\})? 1/);
    expect(body).toContain('dwp_concurrency_lock_conflicts_total');
  });

  it('safeMetrics engole erros do recorder', () => {
    const broken = safeMetrics({
      ...noopMetrics,
      recordWagerTransaction: () => {
        throw new Error('boom');
      },
    });
    expect(() =>
      broken.recordWagerTransaction({
        kind: 'BET',
        status: 'PROCESSED',
        idempotentReplay: false,
        durationSeconds: 0,
      }),
    ).not.toThrow();
  });

  it('CachedValue respeita TTL e fallback', async () => {
    let calls = 0;
    const cache = new CachedValue(
      60_000,
      async () => {
        calls += 1;
        return calls;
      },
      0,
    );
    expect(await cache.get()).toBe(1);
    expect(await cache.get()).toBe(1);
    expect(calls).toBe(1);
  });
});
