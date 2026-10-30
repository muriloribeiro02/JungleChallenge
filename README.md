# Distributed Wagering Processor

Serviço financeiro distribuído do desafio [Jungle Gaming — backend-challenge](https://github.com/junglegaming/backend-challenge).

Processa apostas (`BET` → `WIN` | `LOSS` | `REFUND` | `ROLLBACK`) com saldo materializado, ledger auditável, idempotência persistente, Outbox/Inbox e múltiplas instâncias sobre PostgreSQL + SQS (LocalStack).

Decisões e trade-offs: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Stack e pré-requisitos

| Item | Versão / uso |
|------|----------------|
| Runtime | **Bun 1.x** (lockfile do projeto) |
| Framework | NestJS + TypeScript |
| Banco | PostgreSQL 16 (`docker compose`) |
| Mensageria | AWS SQS via LocalStack 3.8 |
| ORM | TypeORM 0.3.x (migrations manuais) |
| Métricas | Prometheus (`prom-client`) |

Pré-requisitos na máquina: **Bun**, **Docker** + Compose, e (opcional) cliente `psql` / acesso ao container Postgres.

## Configuração de ambiente

```bash
bun install
cp .env.example .env   # se ainda não existir
```

Variáveis principais (ver `.env.example`):

| Variável | Exemplo | Uso |
|----------|---------|-----|
| `DATABASE_PORT` | `5434` | Porta publicada do Postgres no host |
| `DATABASE_*` | user/senha/db | Credenciais PG |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | LocalStack |
| `SQS_MAIN_QUEUE_URL` | `…/jungle-wager-events` | Outbox → domain events |
| `SQS_DLQ_URL` | `…/jungle-wager-events-dlq` | DLQ events |
| `SQS_INBOUND_QUEUE_URL` | `…/jungle-wager-transactions.fifo` | Inbound apostas |
| `SQS_INBOUND_DLQ_URL` | `…/jungle-wager-transactions-dlq.fifo` | DLQ inbound |
| `WORKERS_ENABLED` | `false` no `.env` local; `true` nos `app-*` | Loops Outbox/Inbox/Inbound/Pending |
| `OUTBOX_CLAIM_LEASE_SECONDS` | `60` | Lease do claim Outbox |
| `SQS_MAX_RECEIVE_COUNT` | `5` | Redrive → DLQ |

## Subir a infraestrutura

```bash
docker compose up -d postgres localstack
bun run migration:run
bun run migration:show    # opcional: confirma schema aplicado
```

Filas criadas pelo init do LocalStack (`docker/localstack/init-sqs.sh`):

- `jungle-wager-events` + `jungle-wager-events-dlq` (standard)
- `jungle-wager-transactions.fifo` + `jungle-wager-transactions-dlq.fifo` (FIFO)

### App single-process (dev)

```bash
bun run start:dev
```

API: `http://localhost:3000` (`WORKERS_ENABLED=false` no `.env.example` — workers off nesse modo).

### Três instâncias (workers ligados)

```bash
docker compose up -d postgres localstack
bun run migration:run
bun run apps:up          # app-1:3001  app-2:3002  app-3:3003
```

`GET /health/live` devolve `instanceId` (`app-1`…`app-3`), `pid` e `workersEnabled`.

```bash
bun run apps:down        # docker compose stop app-1 app-2 app-3
```

### Observabilidade

```bash
bun run apps:up
docker compose up -d prometheus
```

- UI Prometheus: http://localhost:9090  
- `/metrics`: http://localhost:3001/metrics (3002, 3003)  
- Catálogo: [`docs/METRICS.md`](docs/METRICS.md)

## Fluxo financeiro (resumo)

1. `POST /wallets` abre carteira (+ `OPENING` + ledger se saldo &gt; 0).
2. `POST /wagering/transactions` (header `Idempotency-Key`) aplica BET/WIN/LOSS/REFUND/ROLLBACK na mesma TX SQL (wallet ± ledger ± outbox).
3. Publisher Outbox claima eventos e publica no SQS (`jungle-wager-events`) — **at-least-once**; Inbox deduplica no consumer.
4. Alternativa: mensagem `WagerTransactionRequested` na fila FIFO inbound → mesmo use case + Inbox.
5. Referência ausente → `PENDING_REFERENCE` + worker com TTL 24h.
6. `POST …/reconciliation` compara saldo × ledger (**não corrige**).

Detalhe: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Endpoints HTTP

| Método | Path | Notas |
|--------|------|-------|
| `POST` | `/wallets` | `playerId`, `initialBalance: { amount, currency }` |
| `GET` | `/wallets/:walletId` | saldo string decimal |
| `GET` | `/wallets/:walletId/ledger?cursor&limit` | cursor opaco |
| `POST` | `/wallets/:walletId/reconciliation` | não corrige divergências |
| `POST` | `/wagering/transactions` | header **obrigatório** `Idempotency-Key` |
| `GET` | `/wagering/transactions/:transactionId` | |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | |
| `GET` | `/health/live` | liveness |
| `GET` | `/health/ready` | Postgres + SQS (503 se down / stopping) |
| `GET` | `/metrics` | Prometheus text |

Money sempre como **string** (`"25.00"`), nunca `number`.

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{
    "providerId":"provider-a",
    "externalTransactionId":"tx-1",
    "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId":"<wallet-uuid>",
    "roundId":"round-1",
    "gameId":"fortune-chimp",
    "kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}
  }'
```

## Testes

> **Aviso — `test:messaging` / e2e SQS**  
> Antes de `bun run test:messaging` (ou qualquer e2e que consuma as mesmas filas LocalStack), **pare as instâncias** com `bun run apps:down`.  
> Com `app-1..3` UP, os workers competem pelas mensagens e os testes flakam.

```bash
bun run test:unit
bun run apps:down          # se apps estiverem no ar
bun run test:e2e
bun run test:messaging
bun run apps:up && bun run test:multi-instance
bun run test:all           # unit + e2e (não inclui multi-instance)
```

Detalhes: [`docs/TESTING.md`](docs/TESTING.md).

## Autenticação (não é produção)

**A autenticação atual é `NoopAuthGuard` (`canActivate` sempre true).**  
Não há IdP. Isso **não** é autenticação de produção — apenas ponto de extensão (`ProviderIdentityPort`). Ver [`ARCHITECTURE.md`](ARCHITECTURE.md) §12.

Health permanece aberto; demais rotas também passam no guard no-op.

## Documentação

| Doc | Conteúdo |
|-----|----------|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | ADRs, trade-offs, limitações |
| [`docs/TESTING.md`](docs/TESTING.md) | Scripts e suítes de teste |
| [`docs/METRICS.md`](docs/METRICS.md) | Catálogo Prometheus |
| [`docs/OUTBOX_INTERVENTION_RUNBOOK.md`](docs/OUTBOX_INTERVENTION_RUNBOOK.md) | Outbox pausado / clear CLI |
| [`docs/OPS_RUNBOOK.md`](docs/OPS_RUNBOOK.md) | Filas, DLQ, PENDING_REFERENCE, ready, reconciliação |

## Migrations (atalho)

```bash
bun run migration:create NomeDaMigration
bun run migration:run
bun run migration:revert
bun run migration:show
```
