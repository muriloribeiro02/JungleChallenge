import { randomUUID } from 'node:crypto';
import {
  MULTI_INSTANCE_BASES,
  dockerCompose,
  sleep,
  waitForInstances,
} from './helpers';

const PROMETHEUS_URL =
  process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090';

/**
 * Fase D — scraping real das três instâncias via Prometheus.
 * Pré-requisito: `docker compose up -d` (apps + prometheus) + migrations.
 */
describe('Prometheus scrape (3 instâncias)', () => {
  beforeAll(async () => {
    await waitForInstances();
    // Garante serviço prometheus no ar (idempotente se já estiver up).
    await dockerCompose(['up', '-d', 'prometheus']);
    await waitForPrometheus(120_000);
  }, 180_000);

  it('cada app expõe /metrics com app_instance distinto', async () => {
    const texts = await Promise.all(
      MULTI_INSTANCE_BASES.map(async (base) => {
        const res = await fetch(`${base}/metrics`);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('dwp_outbox_pending_events');
        return text;
      }),
    );

    expect(texts[0]).toContain('app_instance="app-1"');
    expect(texts[1]).toContain('app_instance="app-2"');
    expect(texts[2]).toContain('app_instance="app-3"');
  });

  it('Prometheus UP nos três targets app-1..3', async () => {
    await waitUntil(async () => {
      const targets = await prometheusJson<{
        data: {
          activeTargets: Array<{
            labels: Record<string, string>;
            health: string;
            lastError?: string;
          }>;
        };
      }>('/api/v1/targets');

      const dwp = targets.data.activeTargets.filter(
        (t) => t.labels.job === 'dwp-apps',
      );
      if (dwp.length < 3) return false;
      return dwp.every((t) => t.health === 'up');
    }, 90_000);

    const targets = await prometheusJson<{
      data: {
        activeTargets: Array<{
          labels: Record<string, string>;
          health: string;
          scrapeUrl: string;
        }>;
      };
    }>('/api/v1/targets');

    const names = targets.data.activeTargets
      .filter((t) => t.labels.job === 'dwp-apps')
      .map((t) => t.labels.instance_name)
      .sort();
    expect(names).toEqual(['app-1', 'app-2', 'app-3']);
  });

  it('PromQL enxerga séries das três instâncias', async () => {
    // Gera atividade em uma instância para ter counter > 0 em algum target.
    const betBase = MULTI_INSTANCE_BASES[0];
    const walletRes = await fetch(`${betBase}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: randomUUID(),
        initialBalance: { amount: '20.00', currency: 'BRL' },
      }),
    });
    expect(walletRes.status).toBe(201);
    const wallet = (await walletRes.json()) as { id: string; playerId: string };

    await fetch(`${betBase}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `prom-scrape:${randomUUID()}`,
      },
      body: JSON.stringify({
        providerId: 'provider-prom',
        externalTransactionId: `tx-${randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-prom',
        gameId: 'g-prom',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    });

    await waitUntil(async () => {
      const q = await prometheusQuery(
        'sum by (app_instance) (dwp_wager_transactions_total)',
      );
      return q.length >= 1;
    }, 60_000);

    const byInstance = await prometheusQuery(
      'count by (instance_name) (up{job="dwp-apps"} == 1)',
    );
    expect(byInstance.length).toBeGreaterThanOrEqual(1);

    const upSum = await prometheusQuery('sum(up{job="dwp-apps"})');
    expect(Number(upSum[0]?.value[1])).toBe(3);
  });

  it('após restart de app-1, Prometheus volta a scrapear UP', async () => {
    await dockerCompose(['restart', 'app-1']);
    await waitUntil(async () => {
      try {
        const live = await fetch(`${MULTI_INSTANCE_BASES[0]}/health/live`);
        return live.status === 200;
      } catch {
        return false;
      }
    }, 120_000);

    await waitUntil(async () => {
      try {
        const targets = await prometheusJson<{
          data: {
            activeTargets: Array<{
              labels: Record<string, string>;
              health: string;
            }>;
          };
        }>('/api/v1/targets');
        const app1 = targets.data.activeTargets.find(
          (t) => t.labels.instance_name === 'app-1',
        );
        return app1?.health === 'up';
      } catch {
        return false;
      }
    }, 90_000);

    // Counters do processo reiniciado começam do zero (comportamento esperado).
    const metrics = await (
      await fetch(`${MULTI_INSTANCE_BASES[0]}/metrics`)
    ).text();
    expect(metrics).toContain('app_instance="app-1"');
    expect(metrics).toContain('dwp_outbox_pending_events');
  }, 180_000);
});

async function waitForPrometheus(timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${PROMETHEUS_URL}/-/ready`);
      if (res.status === 200) return;
    } catch {
      // ainda subindo
    }
    await sleep(1500);
  }
  throw new Error('Prometheus não ficou ready a tempo');
}

async function waitUntil(
  pred: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await pred()) return;
    await sleep(1500);
  }
  throw new Error('timeout waitUntil');
}

async function prometheusJson<T>(path: string): Promise<T> {
  const res = await fetch(`${PROMETHEUS_URL}${path}`);
  if (!res.ok) {
    throw new Error(`Prometheus ${path} → ${res.status}`);
  }
  return (await res.json()) as T;
}

async function prometheusQuery(
  query: string,
): Promise<Array<{ metric: Record<string, string>; value: [number, string] }>> {
  const url = new URL(`${PROMETHEUS_URL}/api/v1/query`);
  url.searchParams.set('query', query);
  const body = await prometheusJson<{
    status: string;
    data: {
      result: Array<{
        metric: Record<string, string>;
        value: [number, string];
      }>;
    };
  }>(`${url.pathname}${url.search}`);
  return body.data.result;
}
