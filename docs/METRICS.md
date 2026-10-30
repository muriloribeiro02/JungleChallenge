# Métricas Prometheus (Fase D)

## Subir e acessar

```bash
docker compose up -d postgres localstack
bun run migration:run
bun run apps:up
docker compose up -d prometheus
```

| Recurso | URL |
|---------|-----|
| UI Prometheus | http://localhost:9090 |
| Targets | http://localhost:9090/targets |
| `/metrics` app-1 | http://localhost:3001/metrics |
| `/metrics` app-2 | http://localhost:3002/metrics |
| `/metrics` app-3 | http://localhost:3003/metrics |

Config versionada: [`docker/prometheus/prometheus.yml`](../docker/prometheus/prometheus.yml).

Sem Grafana nesta fase.

## Arquitetura

- **Application:** `MetricsPort` (`src/application/ports/metrics.ts`) — gravação sem conhecer Prometheus.
- **Infrastructure:** `createPrometheusMetrics` (`prom-client` ≥ 15.1.3, validado no Bun 1.4.4).
- **API:** `GET /metrics` — exposition independente; sem auth local; sem payload financeiro.
- Instrumentação **após** commit da UoW (não altera resultado financeiro; erros de métrica engolidos por `safeMetrics`).

Label estável de baixa cardinalidade: `app_instance` (`INSTANCE_ID`). IDs de wallet/tx/usuário **nunca** são labels.

## Catálogo

| Nome | Tipo | Labels | Significado |
|------|------|--------|-------------|
| `dwp_wager_transactions_total` | Counter | `kind`, `status` | Transações concluídas (PROCESSED/REJECTED/PENDING_REFERENCE) |
| `dwp_wager_idempotent_replays_total` | Counter | `kind` | Replays com `idempotentReplay=true` |
| `dwp_wager_transaction_duration_seconds` | Histogram | `kind` | Duração do Submit (após commit) |
| `dwp_messaging_messages_received_total` | Counter | `consumer` | Mensagens recebidas (`domain_events` \| `wager_inbound`) |
| `dwp_messaging_messages_processed_total` | Counter | `consumer` | Processadas (não duplicata) |
| `dwp_messaging_messages_duplicate_total` | Counter | `consumer` | Duplicatas Inbox |
| `dwp_messaging_messages_failed_total` | Counter | `consumer` | Falhas / abandon sem ACK |
| `dwp_messaging_retries_total` | Counter | `consumer` | `receiveCount > 1` (redelivery observada) |
| `dwp_messaging_processing_duration_seconds` | Histogram | `consumer` | Duração de `pollOnce` |
| `dwp_messaging_in_flight` | Gauge | `consumer` | Em processamento neste processo |
| `dwp_outbox_events_published_total` | Counter | — | Publicações com `markPublished` |
| `dwp_outbox_events_publish_failures_total` | Counter | — | Falhas de publish |
| `dwp_outbox_publish_lag_seconds` | Histogram | — | Lag `occurred_at` → publish |
| `dwp_outbox_pending_events` | Gauge | — | Pendentes no PG (**cache ~10s**) |
| `dwp_outbox_oldest_pending_age_seconds` | Gauge | — | Idade do mais antigo pendente (PG, cache) |
| `dwp_outbox_intervention_required_events` | Gauge | — | Aguardando intervenção manual (PG, cache; **sem eventId**) |
| `dwp_outbox_high_attempt_events` | Gauge | — | Unpublished com `attempts >= 10` (PG, cache) |
| `dwp_sqs_dlq_approximate_messages` | Gauge | `queue` | `ApproximateNumberOfMessages` DLQ (SQS, cache; aproximado) |
| `dwp_concurrency_lock_conflicts_total` | Counter | `kind` | `idempotency_key` \| `reference_reversed` |
| `dwp_reconciliation_runs_total` | Counter | — | Execuções de reconcile |
| `dwp_reconciliation_divergences_total` | Counter | — | `consistent=false` |
| `dwp_reconciliation_duration_seconds` | Histogram | — | Duração reconcile |
| `dwp_pending_reference_*_total` | Counter | — | Outcomes do worker PENDING_REFERENCE |

## Exemplos PromQL

```promql
# Instâncias UP
sum(up{job="dwp-apps"})

# Transações processadas (cluster)
sum(rate(dwp_wager_transactions_total{status="PROCESSED"}[5m])) by (kind)

# Duplicatas Inbox
sum(rate(dwp_messaging_messages_duplicate_total[5m])) by (consumer)

# Outbox pending (máx entre instâncias; valor vem do mesmo PG)
max(dwp_outbox_pending_events)

# Outbox pausados / high attempts
max(dwp_outbox_intervention_required_events)
max(dwp_outbox_high_attempt_events)

# Lag p95 de publicação
histogram_quantile(0.95, sum(rate(dwp_outbox_publish_lag_seconds_bucket[5m])) by (le))

# Divergências de reconciliação
sum(increase(dwp_reconciliation_divergences_total[1h]))
```

## Limitações conhecidas

1. **Counters por processo** — zeram no restart; some no Prometheus (`sum by (...)`).
2. **DLQ** — só profundidade aproximada SQS (`ApproximateNumberOfMessages`); não há counter “enviadas agora” sem poll da DLQ.
3. **Lock wait / SKIP LOCKED skipped** — não instrumentados (não observáveis de forma confiável).
4. **`collectDefaultMetrics`** — desligado por padrão (parcial no Bun).
5. **Gauges PG/SQS** — cache 10s; scrape não executa SQL/API a cada request sem TTL.
6. Filas de eventos local ainda standard (não FIFO) — irrelevante para nomes de métrica.
