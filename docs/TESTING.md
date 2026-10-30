# Testes

Documentação exclusiva dos scripts e da organização de testes deste projeto.

Política obrigatória (unitário + e2e + doc): ver [`skills/AGENTS.md`](../skills/AGENTS.md).

Sempre documentar quando houver uma atualização em teste neste arquivo.

## Suítes (diferencie antes de rodar)

| Suíte | Script (`package.json`) | Precisa Postgres? | Precisa LocalStack? | Precisa `apps:up`? |
|-------|-------------------------|-------------------|---------------------|--------------------|
| Unitário | `bun run test:unit` | Não (fakes) | Não | Não |
| E2E | `bun run test:e2e` | **Sim** (maioria) | Sim se o arquivo tocar SQS (`*sqs*`, inbound) | **Não** — preferir `apps:down` |
| Messaging | `bun run test:messaging` | **Sim** | **Sim** | **Não** — **obrigatório `apps:down`** |
| Multi-instância | `bun run test:multi-instance` | **Sim** | **Sim** | **Sim** |
| `test:all` | `test:unit` + `test:e2e` | Indireto (e2e) | Indireto | Não inclui multi-instance |

> **Aviso em destaque**  
> Antes de `bun run test:messaging` (e de e2e SQS em geral), execute `bun run apps:down`.  
> Os containers `app-1..3` têm `WORKERS_ENABLED=true` e **consomem as mesmas filas** LocalStack que os testes. Deixar apps UP causa flake (mensagem some / claimed=0).

Migrations usadas pelos helpers/e2e de schema: lista em `test/helpers/migration-data-source.ts` (`ALL_MIGRATIONS`) — de `001-Create_table_wallet` até `OutboxInterventionFields1793389000000` (15 migrations).

## Scripts

Fonte: `package.json` → `scripts`.

| Script | Comando | O que faz |
|--------|---------|-----------|
| `test` | `bun run test` | Atalho legado do Nest: specs em `src/` (`*.spec.ts`) |
| `test:unit` | `bun run test:unit` | Unitários `test/**/*.spec.ts` (`jest-unit.json`) |
| `test:e2e` | `bun run test:e2e` | E2E `test/**/*.e2e-spec.ts` exceto `multi-instance/` |
| `test:all` | `bun run test:all` | `test:unit` && `test:e2e` |
| `test:messaging` | `bun run test:messaging` | Jest e2e filtrado `messaging.sqs` |
| `test:multi-instance` | `bun run test:multi-instance` | `jest-multi-instance.json` |
| `apps:up` | `bun run apps:up` | build `app-1` + up `app-1..3` |
| `apps:down` | `bun run apps:down` | `docker compose stop app-1 app-2 app-3` |
| `ops:clear-outbox-intervention` | `bun run ops:clear-outbox-intervention -- <uuid>` | CLI ops Outbox (não é teste) |
| `migration:run` / `revert` / `show` | `bun run migration:*` | Schema via profile `migrate` |
| (filtro) | `bun run test:e2e -- http.api` | E2E HTTP Nest + Postgres |
| (filtro) | `bun run test:unit -- metrics` | Unit métricas |
| (filtro) | `bun run test:e2e -- metrics` | E2E `/metrics` |
| (filtro) | `bun run test:multi-instance -- prometheus` | Scrape Prometheus |
| `test:watch` | `bun run test:watch` | Watch (config Jest raiz / `src/`) |
| `test:cov` | `bun run test:cov` | Cobertura specs `src/` |
| `test:debug` | `bun run test:debug` | Jest + inspector |

### Filtrar por nome

```bash
bun run test:unit -- wallet.entity
bun run test:unit -- wallet.mapper
bun run test:unit -- get-wallet-balance
bun run test:unit -- open-wallet.use-case
bun run test:unit -- place-bet.use-case
bun run test:unit -- settle-win
bun run test:unit -- settle-loss
bun run test:unit -- refund-wager
bun run test:unit -- rollback-wager
bun run test:unit -- reprocess-pending
bun run test:unit -- refund-rollback.migration
bun run test:unit -- pending-reference-lookup
bun run test:unit -- wager-transaction
bun run test:unit -- wallet-ledger-entry
bun run test:unit -- outbox-message.migration
bun run test:unit -- outbox-intervention
bun run test:unit -- clear-outbox-intervention
bun run test:unit -- wallet.migration
bun run test:e2e -- outbox-intervention
bun run test:e2e -- wallet.constraints
bun run test:e2e -- open-wallet.use-case
bun run test:e2e -- place-bet.use-case
bun run test:e2e -- settle-win-loss
bun run test:e2e -- refund-rollback
bun run test:e2e -- reprocess-pending
bun run test:messaging
bun run test:e2e -- wager-transaction.constraints
bun run test:e2e -- wallet-ledger-entry.constraints
bun run test:e2e -- outbox-message.constraints
bun run test:e2e -- wallet.migration
bun run test:e2e -- wallet.repository
```

## Organização

```
test/
  helpers/
    db.ts                      # Postgres + insertWallet/tx/ledger/outbox
    migration-data-source.ts   # DataSource TypeORM — ALL_MIGRATIONS (001 → OutboxIntervention)
  metrics/
    prometheus-metrics.spec.ts            # unit: counters/histograms/safeMetrics/cache
    metrics-instrumentation.spec.ts       # unit: Submit/Inbox/Outbox → métricas
    metrics.e2e-spec.ts                   # e2e: GET /metrics, BET, replay, reconcile
  api/
    http.api.e2e-spec.ts                  # e2e: REST §9; 404; 202 PENDING_REFERENCE; magnitude 400
    http-exception.filter.spec.ts         # unit: mapHttpError 404/409/400/500
    money.dto.spec.ts                     # unit: MoneyDto escala + magnitude shared
    health.controller.spec.ts             # unit: live/ready via DependencyHealthPort
    health.e2e-spec.ts                    # e2e: ready 200/503 via checkAvailable; sem receive; mensagem permanece visível; live stopping
  infrastructure/
    typeorm-sqs-dependency-health.spec.ts # unit: PG/SQS via checkAvailable; nunca chama receive
    sqs-message-bus.check-available.spec.ts # unit: GetQueueAttributes QueueArn ok/falha
  shared/
    money-limits.spec.ts                  # unit: isMoneyAmountWithinMaxAbs
  messaging/
    outbox-publisher.use-case.spec.ts     # unit: backoff / markPublished (ports)
    inbox-consumer.use-case.spec.ts       # unit: inbox, duplicata, fail sem ACK + visibility=0
    messaging.migration.spec.ts           # unit: SQL 009/010
    messaging.sqs.e2e-spec.ts             # e2e: PG + LocalStack SQS (publish/claim/DLQ/inbox)
                                          # wiring via UnitOfWork + composition helpers
  wallet/
    reconcile-wallet.use-case.spec.ts     # unit: reconciliação saldo×ledger
  wager/
    submit-wager-transaction.use-case.spec.ts # unit: fachada HTTP→use cases
  money/
    money.spec.ts              # unit: precisão e moeda em Money.from
  outbox/
    outbox-message.migration.spec.ts      # unit: SQL up/down outbox
    outbox-message.constraints.e2e-spec.ts # e2e: imutabilidade + campos operacionais (+ intervenção)
    outbox-intervention.policy.spec.ts    # unit: limiar 10 + sanitize de erro
    outbox-intervention.publisher.spec.ts # unit: retry vs pausa + log único
    outbox-intervention.migration.spec.ts # unit: SQL up/down OutboxInterventionFields
    clear-outbox-intervention.use-case.spec.ts # unit: clear preserva attempts/payload
    outbox-intervention.e2e-spec.ts       # e2e: claim/pausa/clear/lease/SKIP LOCKED + migration up/down
  wager-transaction/
    wager-transaction.entity.spec.ts      # unit: OPENING/BET/REFUND/ROLLBACK + snapshot
    wager-transaction.mapper.spec.ts      # unit: ORM ↔ domínio + snapshot
    wager-transaction.migration.spec.ts   # unit: SQL up/down wager_transaction
    wager-transaction-result-snapshot.migration.spec.ts # unit: SQL up/down 006 snapshot
    wager-transaction-result-snapshot.migration.e2e-spec.ts # e2e: 006 colunas, backfill, CHECKs
    refund-rollback.migration.spec.ts     # unit: SQL up/down 007 PENDING_REFERENCE + UNIQUE
    unique-any-processed-reversal.migration.spec.ts # unit: SQL up/down 011 UNIQUE cross-kind
    pending-reference-lookup.migration.spec.ts # unit: SQL up/down 008 índice pending
    wager-transaction.constraints.e2e-spec.ts # e2e: status, amount, idempotência, moeda
  wager/
    place-bet.use-case.spec.ts / .e2e-spec.ts
    settle-win.use-case.spec.ts
    settle-loss.use-case.spec.ts
    settle-win-loss.use-case.e2e-spec.ts  # e2e: WIN/LOSS PG
    refund-wager.use-case.spec.ts         # unit: REFUND (+ cross-kind vs ROLLBACK)
    rollback-wager.use-case.spec.ts       # unit: ROLLBACK (+ cross-kind vs REFUND)
    refund-rollback.use-case.e2e-spec.ts  # e2e: REFUND/ROLLBACK PG
    refund-rollback-cross-kind.use-case.e2e-spec.ts # e2e: H1 REFUND×ROLLBACK PG
    reprocess-pending-references.use-case.spec.ts / .e2e-spec.ts
  wallet-ledger/
    wallet-ledger-entry.entity.spec.ts    # unit: CREDIT/DEBIT, saldos, imutabilidade
    wallet-ledger-entry.migration.spec.ts # unit: SQL up/down ledger
    wallet-ledger-entry.constraints.e2e-spec.ts # e2e: moeda, LOSS, UPDATE/DELETE
  wallet/
    wallet.entity.spec.ts                # unit: criação/validação da entidade
    wallet.mapper.spec.ts                # unit: mapeamento domínio ↔ ORM
    get-wallet-balance.use-case.spec.ts  # unit: consulta de saldo (repo fake)
    open-wallet.use-case.spec.ts         # unit: orquestração abertura
    open-wallet.use-case.e2e-spec.ts     # e2e: atomicidade/rollback PG
    wallet.repository.e2e-spec.ts        # e2e: save/findById no Postgres
    wallet.constraints.e2e-spec.ts       # e2e: constraints da tabela wallet
    wallet.migration.spec.ts             # unit: SQL up/down da migration
    wallet.migration.e2e-spec.ts         # e2e: revert cascata + run (inclui AlignMonetary + OutboxIntervention)
  multi-instance/                        # fora do test:e2e — ver seção Multi-instância
  jest-unit.json
  jest-e2e.json
  jest-multi-instance.json
```

## Suíte atual — money / wallet / financeiro (domínio)

| Arquivo | Tipo | Cobre |
|---------|------|-------|
| `api/http-exception.filter.spec.ts` | unit | `mapHttpError`: 404 refund/rollback; 409 conflitos For*; regressão 400/500 |
| `api/money.dto.spec.ts` | unit | MoneyDto: limite, escala, formatos inválidos |
| `shared/money-limits.spec.ts` | unit | magnitude NUMERIC(19,2) compartilhada |
| `api/health.controller.spec.ts` | unit | live/ready via porta (sem TypeORM/SQS) |
| `infrastructure/typeorm-sqs-dependency-health.spec.ts` | unit | adapter: `checkAvailable` (não `receive`); PG/SQS fail |
| `infrastructure/sqs-message-bus.check-available.spec.ts` | unit | `GetQueueAttributes` QueueArn; rejeita sem ARN / SDK error |
| `api/health.e2e-spec.ts` | e2e | ready 200/503; spy sem `receive`; NotVisible estável após probes; live stopping |
| `api/http.api.e2e-spec.ts` | e2e | REST §9; 202 PENDING_REFERENCE; 404; 409; magnitude 400 |
| `money/money.spec.ts` | unit | `from`/`fromPersisted`; magnitude em add/subtract/negate (MAX±); moeda; negativos internos |
| `money/align-monetary-scale.migration.spec.ts` | unit | SQL up/down `AlignMonetaryNumericScaleNineteenTwo` + abort se dados com >2 casas |
| `wallet.entity.spec.ts` | unit | `open` / `rehydrate` / `credit` / `debit`: version, moeda, saldo |
| `settle-win.use-case.spec.ts` | unit | WIN: crédito, ledger, eventos, idempotência, conflitos |
| `settle-loss.use-case.spec.ts` | unit | LOSS: amount 0, sem ledger, 1 evento, idempotência |
| `settle-win-loss.use-case.e2e-spec.ts` | e2e | WIN/LOSS PG: snapshot, race WIN×BET, rollback, external id |
| `refund-wager.use-case.spec.ts` | unit | REFUND: BET válida, WIN inválida, escopo/amount, PENDING_REFERENCE, duplicata, cross-kind vs ROLLBACK |
| `rollback-wager.use-case.spec.ts` | unit | ROLLBACK: BET/WIN/REFUND, saldo negativo, PENDING_REFERENCE, duplicata, cross-kind vs REFUND |
| `refund-rollback.use-case.e2e-spec.ts` | e2e | REFUND/ROLLBACK PG: saldo, ledger, PENDING_REFERENCE, race duplicada, UNIQUE, atomicidade |
| `refund-rollback-cross-kind.use-case.e2e-spec.ts` | e2e | H1: REFUND×ROLLBACK sequencial/simultâneo, reprocess, falha técnica, UNIQUE PG, ledger |
| `unique-any-processed-reversal.migration.spec.ts` | unit | `up`/`down` da 011: UNIQUE cross-kind PROCESSED |
| `reprocess-pending-references.use-case.spec.ts` | unit | reprocessamento: REFUND/ROLLBACK, rejeição, 2 pendências, cross-kind, defer+backoff, TTL→REFERENCE_NOT_FOUND, outro provider |
| `reprocess-pending-references.use-case.e2e-spec.ts` | e2e | reprocess PG: saldo/ledger/eventos, corrida, rollback técnico, provider isolation |
| `process-pending-references.use-case.spec.ts` | unit | worker claim + TTL expire único Rejected |
| `process-pending-references.use-case.e2e-spec.ts` | e2e | TTL expire+outbox; 3 claims concorrentes → 1 terminal; ref antes do TTL |
| `pending-reference-policy.spec.ts` | unit | TTL 24h; backoff min(300, 2^n) |
| `pending-reference-ttl.migration.spec.ts` | unit | SQL up/down 013 (`pending_reference_at`, claim) |
| `wallet.mapper.spec.ts` | unit | `WalletMapper` toPersistence/toDomain; rejeita precisão inválida na reidratação |
| `wager-transaction.mapper.spec.ts` | unit | reidratação; rejeita `amount` com precisão inválida |
| `get-wallet-balance.use-case.spec.ts` | unit | `GetWalletBalanceUseCase`: encontrada / inexistente (InMemoryWalletRepository) |
| `open-wallet.use-case.spec.ts` | unit | `OpenWalletUseCase`: zero / positivo / negativo / duplicata / orquestração |
| `open-wallet.use-case.e2e-spec.ts` | e2e | abertura no Postgres: persistência, duplicata, rollback real |
| `place-bet.use-case.spec.ts` | unit | `PlaceBetUseCase`: aprovada, REJECTED, idempotência, conflito, amount |
| `place-bet.use-case.e2e-spec.ts` | e2e | BET PG: snapshot, replay sem outbox, legado sem snapshot, concorrência, rollback |

> E2E: `maxWorkers: 1` em `jest-e2e.json` para evitar corrida na mesma base. Limpeza de ledger usa `SET LOCAL session_replication_role = 'replica'` (sem desabilitar trigger globalmente).
| `wager-transaction.entity.spec.ts` | unit | OPENING/BET/WIN/LOSS/REFUND/ROLLBACK + snapshot; PENDING_REFERENCE; markProcessed |
| `wager-transaction.mapper.spec.ts` | unit | snapshot round-trip escala 2; legado NULL sem inventar |
| `wallet-ledger-entry.entity.spec.ts` | unit | `credit`/`debit`/`rehydrate`: equação de saldo, moedas, `balanceAfter` negativo, freeze + Date defensivo |
| `wager-transaction.migration.spec.ts` | unit | `up`/`down` da `CreateWagerTransactionTable` |
| `wager-transaction-result-snapshot.migration.spec.ts` | unit | `up`/`down` da 006: colunas nullable, backfill ledger, CHECKs |
| `refund-rollback.migration.spec.ts` | unit | `up`/`down` da 007: CHK PENDING_REFERENCE + UNIQUE REFUND/ROLLBACK PROCESSED |
| `pending-reference-lookup.migration.spec.ts` | unit | `up`/`down` da 008: índice parcial PENDING_REFERENCE |
| `wager-transaction-result-snapshot.migration.e2e-spec.ts` | e2e | 006: ida/volta colunas; backfill `observed_balance`; version NULL; CHECKs |
| `wallet-ledger-entry.migration.spec.ts` | unit | `up`/`down` da `CreateWalletLedgerEntryTable` |
| `wallet-ledger-entry.mapper.spec.ts` | unit | rejeita precisão inválida na reidratação (`fromPersisted`) |
| `outbox-message.migration.spec.ts` | unit | `up`/`down` da `CreateOutboxMessageTable` |
| `wager-transaction.constraints.e2e-spec.ts` | e2e | status oficiais (+ inválido), amount por kind, idempotência/id externo por provedor, moeda |
| `wallet-ledger-entry.constraints.e2e-spec.ts` | e2e | moeda, bloqueio LOSS, UPDATE/DELETE imutáveis |
| `outbox-message.constraints.e2e-spec.ts` | e2e | payload/campos imutáveis; UPDATE operacional; DELETE não restringido pelo contrato |
| `wallet.repository.e2e-spec.ts` | e2e | `TypeOrmWalletRepository.save` / `findById` com Postgres real |
| `wallet.constraints.e2e-spec.ts` | e2e | `numeric(19,2)`; CHECK negativo (≥0.01), UNIQUE, PK, NOT NULL |
| `wallet.migration.spec.ts` | unit | `up`/`down` da `CreateWalletTable` |
| `wallet.migration.e2e-spec.ts` | e2e | revert cascata →001; run recria até `OutboxInterventionFields1793389000000` |

```bash
bun run test:unit -- wager-transaction-result-snapshot.migration
bun run test:e2e -- wager-transaction-result-snapshot.migration
bun run test:unit -- refund-rollback.migration
bun run test:unit -- unique-any-processed-reversal.migration
bun run test:e2e -- refund-rollback
bun run test:e2e -- refund-rollback-cross-kind
bun run test:unit -- reprocess-pending
bun run test:unit -- process-pending
bun run test:unit -- pending-reference
bun run test:e2e -- reprocess-pending
bun run test:e2e -- process-pending
```


> DELETE em `outbox_message`: contrato não exige bloqueio; migration e testes não inventam essa regra.

## Requisitos por feature

Toda feature nova precisa de:

1. **Unitário** (`*.spec.ts`) — validação/domínio/use case isolado
2. **E2E** (`*.e2e-spec.ts`) — comportamento integrado (API e/ou banco)
3. **Doc** — atualizar este arquivo descrevendo o que mudou

## Mensageria (Outbox / Inbox / SQS)

Pré-requisito: `docker compose up -d postgres localstack`, `bun run migration:run`, e **`bun run apps:down`**.

| Arquivo | Tipo | Cobre |
|---------|------|-------|
| `messaging/outbox-publisher.use-case.spec.ts` | unit | backoff `next_attempt_at`, API do publisher |
| `messaging/inbox-consumer.use-case.spec.ts` | unit | inbox nova, duplicata+ACK por `(consumerName, id)`, falha sem ACK + `changeVisibility(0)` |
| `messaging/messaging-workers.host.spec.ts` | unit | flag `WORKERS_ENABLED`; ticks outbox/inbox/inbound/pending |
| `messaging/graceful-shutdown.spec.ts` | unit | C3: ocioso; drain outbox/inbox/inbound/pending; timeout `SHUTDOWN_DRAIN_MS`; sem poll pós-stop |
| `messaging/shutdown-abandon-visibility.spec.ts` | unit | abandon sem ACK + VT=0; Host drain_timeout libera receipts |
| `messaging/inbound-wager-consumer.use-case.spec.ts` | unit | parse envelope; processa; duplicata; money number sem ACK |
| `messaging/messaging.migration.spec.ts` | unit | SQL up 009 (`locked_until`) e 010 (`inbox_message`) |
| `messaging/messaging.sqs.e2e-spec.ts` | e2e | publish, retry, SKIP LOCKED, inbox/dedupe, VT/DLQ, 3 consumers |
| `messaging/inbound-wager.sqs.e2e-spec.ts` | e2e | FIFO inbound: válida, duplicata, falha pré-commit, 2 consumers |

```bash
bun run test:unit -- messaging
bun run test:messaging
bun run test:e2e -- inbound-wager
```

> SQS real via LocalStack (sem mock no e2e). Credenciais `test`/`test` só para endpoint local.

## Multi-instância (Fase B — 3 processos)

Pré-requisito: postgres + localstack + migrations + `bun run apps:up`.

| Arquivo | Tipo | Cobre |
|---------|------|-------|
| `multi-instance/multi-instance.e2e-spec.ts` | e2e multi-processo | A–E; F/H–G; **F/I**: `drain_timeout` real (`SHUTDOWN_TEST_HOLD_MS`) + lease recovery |
| `multi-instance/prometheus-scrape.e2e-spec.ts` | e2e multi-processo | Fase D: `/metrics` 3 apps; Prometheus targets UP; PromQL; restart app-1 |
| `multi-instance/helpers.ts` | helper | wait `/health`, `dockerCompose`, `submitRefund`, cleanup PG |
| `metrics/prometheus-metrics.spec.ts` | unit | registry, labels, safeMetrics, CachedValue |
| `metrics/metrics-instrumentation.spec.ts` | unit | Submit/Inbox/Outbox incrementam counters |
| `metrics/metrics.e2e-spec.ts` | e2e | `/metrics`, BET, replay idempotente, reconcile |

```bash
bun run apps:up
docker compose up -d prometheus
bun run test:multi-instance
bun run test:multi-instance -- prometheus
bun run apps:down   # pare os apps antes de test:messaging / e2e SQS (mesma fila)
```

Evidências: `instanceId` distintos em `/health/live`; requisições com `base` 3001/3002/3003; `published_at` único por outbox id.

> `test/multi-instance` fica fora do `test:e2e` (`testPathIgnorePatterns`) — exige os containers `app-*`.

## Banco nos e2e

- Postgres via Docker: `docker compose up -d postgres`
- LocalStack SQS: `docker compose up -d localstack` (porta `4566`)
- Porta do app: ver `DATABASE_PORT` no `.env` (ex.: `5434`)
- Preferir `BEGIN`/`ROLLBACK` por teste para não sujar dados
- Testes de migration alteram schema de verdade e devem restaurar o estado no `afterAll`

## Configs Jest

| Arquivo | Uso |
|---------|-----|
| `test/jest-unit.json` | Unitários (`test:unit`) |
| `test/jest-e2e.json` | E2E (`test:e2e`) |
| `test/jest-multi-instance.json` | Multi-instância (`test:multi-instance`) |
| `package.json` → `jest` | Config padrão do Nest para specs em `src/` |

`ts-jest` nos configs sob `test/` aponta para `tsconfig.json` da raiz (`strict: true`), para o typecheck dos testes acompanhar o mesmo modo estrito do build.
