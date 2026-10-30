# Distributed Wagering Processor

Desafio Jungle Gaming — serviço financeiro distribuído (NestJS + Bun + PostgreSQL + SQS).

Contrato oficial: [junglegaming/backend-challenge](https://github.com/junglegaming/backend-challenge).

## Setup local

```bash
bun install
cp .env.example .env   # se ainda não existir
docker compose up -d postgres localstack
bun run migration:run
bun run start:dev
```

- API (dev single-process): `http://localhost:3000`
- Documentação dos endpoints: este README + [`ARCHITECTURE.md`](ARCHITECTURE.md)

### Três instâncias (Fase B)

Mesmo PostgreSQL e LocalStack; workers (Outbox + Inbox) ligados em cada processo:

```bash
docker compose up -d postgres localstack
bun run migration:run
bun run apps:up          # app-1:3001 app-2:3002 app-3:3003
bun run test:multi-instance
bun run apps:down        # pare antes de test:messaging (mesma fila SQS)
```

`GET /health/live` devolve `instanceId` (`app-1`…`app-3`), `pid` e `workersEnabled`.

### Observabilidade (Fase D — Prometheus)

```bash
docker compose up -d prometheus   # após apps:up
```

- UI: http://localhost:9090 (targets: job `dwp-apps` → app-1/2/3)
- Por instância: `GET http://localhost:3001/metrics` (3002, 3003)
- Catálogo, PromQL e limitações: [`docs/METRICS.md`](docs/METRICS.md)
- Sem Grafana nesta fase

## Endpoints HTTP

| Método | Path | Notas |
|--------|------|-------|
| `POST` | `/wallets` | body: `playerId`, `initialBalance: { amount, currency }` |
| `GET` | `/wallets/:walletId` | saldo como string decimal |
| `GET` | `/wallets/:walletId/ledger?cursor&limit` | cursor opaco |
| `POST` | `/wallets/:walletId/reconciliation` | não corrige divergências |
| `POST` | `/wagering/transactions` | header **obrigatório** `Idempotency-Key` |
| `GET` | `/wagering/transactions/:transactionId` | |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | |
| `GET` | `/health/live` | sem auth |
| `GET` | `/health/ready` | Postgres + SQS |
| `GET` | `/metrics` | Prometheus text; sem auth local; sem saldos/IDs |

Exemplo BET:

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

Valores monetários são **sempre strings** (`"25.00"`), nunca `number`.

## Testes

```bash
bun run test:unit
bun run test:e2e
bun run test:messaging
bun run test:multi-instance   # requer apps:up
bun run test:all
```

Detalhes: [`docs/TESTING.md`](docs/TESTING.md). Decisões: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Autenticação

Não há IdP neste entrega (opcional no contrato). Extensão: `NoopAuthGuard` / `ProviderIdentityPort` em `src/api/auth/`.
