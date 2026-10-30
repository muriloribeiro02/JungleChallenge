# Architecture

## Camadas

- **domain** — entidades, VOs (`Money`), portas de repositório, eventos
- **application** — use cases, ports (`UnitOfWork`, `MessageBus`), workers de mensageria
- **infrastructure** — TypeORM, SQS, logging, env
- **composition** — wiring único (`createAppComposition`)
- **api** — controllers Nest, DTOs HTTP, filtros, `NoopAuthGuard`

## ORM

**TypeORM** (aceitável pelo contrato). Transações via `TypeOrmUnitOfWork` + `SELECT FOR UPDATE` na wallet. `Money` persiste como `numeric` + `currency` string, reidratado no mapper — nunca `number` no domínio.

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

`POST /wallets/:id/reconciliation` compara saldo materializado com Σ(CREDIT−DEBIT) do ledger. Divergência **não** é corrigida — log `wallet.reconciliation_divergence`.

## Mensageria

Outbox claim (`SKIP LOCKED`) → SQS; Inbox + ACK após commit. Filas locais via LocalStack (nomes do ambiente atual).

### Workers por processo (Fase B)

Com `WORKERS_ENABLED=true`, cada instância Nest agenda loops independentes
(`MessagingWorkersHost`): `outboxPublisher.publishBatch()` e
`inboxConsumer.pollOnce()`. Claim continua `FOR UPDATE SKIP LOCKED` +
`locked_until` — vários publishers não “roubam” a mesma linha enquanto o lease
é válido.

Compose: serviços explícitos `app-1` / `app-2` / `app-3` (mesma imagem, portas
host 3001–3003). `INSTANCE_ID` identifica o processo em `/health/live`.

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

- Métricas Prometheus/OpenTelemetry não implementadas (logs estruturados sim).
- Filas SQS do contrato citam `.fifo`; o ambiente local usa filas standard (LocalStack) — documentado na etapa de mensageria.
