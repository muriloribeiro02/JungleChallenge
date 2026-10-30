# Architecture

## Camadas

- **domain** — entidades, VOs (`Money`), portas de repositório, eventos
- **application** — use cases, ports (`UnitOfWork`, `MessageBus`, `MetricsPort`), workers de mensageria
- **infrastructure** — TypeORM, SQS, logging, env, adapter Prometheus (`prom-client`)
- **composition** — wiring único (`createAppComposition`)
- **api** — controllers Nest, DTOs HTTP, filtros, `NoopAuthGuard`, `GET /metrics`

## ORM

**TypeORM** (aceitável pelo contrato). Transações via `TypeOrmUnitOfWork` + `SELECT FOR UPDATE` na wallet. `Money` persiste como **`numeric(19,2)`** + `currency` string, reidratado via `Money.fromPersisted` — nunca `number` no domínio. Escala 2 no Domain/API/ORM/PG (migration `AlignMonetaryNumericScaleNineteenTwo`).

**Limitação PG:** `NUMERIC(19,2)` **arredonda** (não rejeita) entradas com >2 casas no INSERT/UPDATE. A rejeição obrigatória fica em `Money` / `MoneyDto`; o tipo no banco alinha armazenamento e magnitude (máx. `99999999999999999.99`), não substitui validação de aplicação.

## API HTTP (contrato §9)

| Método | Path | Status principais |
|--------|------|-------------------|
| POST | `/wallets` | 201 / 409 |
| GET | `/wallets/:walletId` | 200 / 404 |
| GET | `/wallets/:walletId/ledger?cursor&limit` | 200 / 404 |
| POST | `/wallets/:walletId/reconciliation` | 200 / 404 |
| POST | `/wagering/transactions` | 200 (negócio) / 202 (`PENDING_REFERENCE`) / 400 / 409 |
| GET | `/wagering/transactions/:transactionId` | 200 / 404 |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | 200 / 404 |
| GET | `/health/live` | 200 |
| GET | `/health/ready` | 200 / 503 |
| GET | `/metrics` | 200 (Prometheus text) |

### Status codes (decisão)

O contrato exige distinção clara, sem ditar códigos. Adotamos:

- **400** — validação / payload inválido / header `Idempotency-Key` ausente
- **404** — wallet ou transação inexistente
- **409** — wallet duplicada, conflito de idempotência (mesmo key, payload diferente), unique de id externo
- **200** — submit com `PROCESSED` ou `REJECTED` (rejeição de negócio no body + `failureCode`)
- **202** — submit com `PENDING_REFERENCE`
- **503** — readiness (Postgres/SQS indisponíveis)
- **500** — erro inesperado (sem SQL/stack na resposta)

### Autenticação (decisão §2)

Não implementamos IdP (sem pontos na rubrica). `NoopAuthGuard` + `ProviderIdentityPort` documentam o ponto de extensão. Health permanece aberto.

### Idempotência

Header `Idempotency-Key` obrigatório em `POST /wagering/transactions`. Hash canônico já usado nos use cases (`canonical-payload-hash`). Replay → mesma resposta com `idempotentReplay: true`.

### Reconciliação

`POST /wallets/:id/reconciliation` compara saldo materializado com Σ(CREDIT−DEBIT) do ledger. Divergência **não** é corrigida — log `wallet.reconciliation_divergence` (sem saldos; resposta HTTP mantém os valores do contrato §9).

## Mensageria

Outbox claim (`SKIP LOCKED`) → SQS; Inbox + ACK após commit. Filas locais via LocalStack (nomes do ambiente atual).

### Workers por processo (Fase B/C)

Com `WORKERS_ENABLED=true`, cada instância Nest agenda loops independentes
(`MessagingWorkersHost`): Outbox publish, Inbox de **eventos** e Inbound
`WagerTransactionRequested`. Claim outbox: `FOR UPDATE SKIP LOCKED` +
`locked_until`.

Compose: `app-1` / `app-2` / `app-3` (portas 3001–3003). `INSTANCE_ID` em
`/health/live`.

### Filas SQS (decisão §10)

| Fila | Tipo | Uso |
|------|------|-----|
| `jungle-wager-transactions.fifo` (+ DLQ `.fifo`) | **FIFO** | Inbound `WagerTransactionRequested` — alinhado ao contrato |
| `jungle-wager-events` (+ DLQ) | Standard | Eventos de integração (outbox) |

A fila de **eventos** permanece standard no ambiente local (histórico Fase B);
a de **entrada de apostas** é FIFO conforme o contrato. Inbox deduplica por
`(consumer_name, message_id)`.

### Inbound (Fase C1)

`InboundWagerConsumer`: valida envelope (money como string) → UoW única
`inbox.tryInsert` + `SubmitWagerTransactionUseCase.executeWithRepos` (efeito +
outbox) → ACK após commit.

### PENDING_REFERENCE TTL (Fase C2)

- `pending_reference_at`: momento de entrada em `PENDING_REFERENCE` (TTL **24h**).
- Backoff de reavaliação: `next_attempt_at = now + min(300, 2^n)` s
  (`n = pending_attempt_count`); sem teto extra de tentativas.
- Expiração prevalece sobre `next_attempt_at` futuro.
- Claim multi-instância: `FOR UPDATE SKIP LOCKED` + `locked_until` (só lease).
- `pending_attempt_count` incrementa em **defer** (`recordDeferRetry`), comum a
  Inbox e worker — não no claim (evita contornar backoff no caminho Inbox).
- Expiração → `REJECTED` + `REFERENCE_NOT_FOUND` + outbox
  `WagerTransactionRejected` na mesma UoW.
- Worker: `ProcessPendingReferencesUseCase` no `MessagingWorkersHost`
  (`WORKER_PENDING_INTERVAL_MS`).

### Graceful shutdown (Fase C3)

- `main.ts`: `app.enableShutdownHooks()` — Nest propaga SIGTERM/SIGINT.
- Ordem: `MessagingWorkersHost.beforeApplicationShutdown` (stopped + clear
  timers + await in-flight até `SHUTDOWN_DRAIN_MS`) →
  `AppModule.onModuleDestroy` (`DataSource.destroy`).
- Limpar timer **não** cancela tick em voo; só impede novos polls.
- ACK Inbox/Inbound permanece após commit; interrupção pré-ACK → redelivery
  (at-least-once + Inbox).
- `/health/ready` → 503 se `stopping`; Compose: `stop_signal: SIGTERM`,
  `stop_grace_period: 15s`.
- **Drain timeout:** marca `abandonInFlight` → sem ACK; `ChangeMessageVisibility(0)`
  best-effort nos receipts tracked; outbox claimada recupera via `locked_until`.
  Se VT=0 falhar, permanece o visibility timeout original.
- Probe de teste: `SHUTDOWN_TEST_HOLD_MS` (0 em prod) — hold após receive/claim.

### Observabilidade Prometheus (Fase D)

- Porta `MetricsPort` + `safeMetrics` (falha de métrica não afeta TX financeira).
- Adapter `createPrometheusMetrics` (Bun 1.4.4 + `prom-client` 15.x).
- Counters/histograms por processo; gauges de outbox (PG) e DLQ (SQS) com cache ~10s.
- Compose: serviço `prometheus` scrapa `app-1`/`app-2`/`app-3` (`docker/prometheus/prometheus.yml`).
- Catálogo: [`docs/METRICS.md`](docs/METRICS.md). Sem Grafana nesta fase.

## Reversões REFUND / ROLLBACK (decisão §7)

Contrato §7.4: uma referência não pode ser revertida duas vezes pelo **mesmo tipo**.
Tabela §7: REFUND reverte BET “uma única vez”; ROLLBACK reverte a referência “uma única vez”.
Invariante global: não duplicar créditos.

**Interpretação adicional (documentada):** no máximo **uma** reversão `PROCESSED`
(`REFUND` **ou** `ROLLBACK`) por `(providerId, external_reference)`.
Impede REFUND+ROLLBACK da mesma BET (ambos creditariam).
`ROLLBACK` de um `REFUND` continua válido: a referência externa é o id externo do
REFUND, não o da BET. Índice: `UQ_wager_transaction_processed_reversal_ref` (migration 011).

## Limitações conhecidas

- OpenTelemetry tracing ainda não implementado (métricas Prometheus sim — Fase D).
- Counters zeram no restart do processo; DLQ depth é aproximada (SQS); ver `docs/METRICS.md`.
- Fila de **eventos** local permanece standard; inbound de apostas é FIFO.
