# Architecture — Distributed Wagering Processor

Documento de arquitetura e decisões (ADR simplificado).  
Contrato oficial: [junglegaming/backend-challenge](https://github.com/junglegaming/backend-challenge).

Evidências apontam para arquivos reais da implementação. Onde algo **não** está implementado, está dito explicitamente.

---

## Sumário

1. [Visão das camadas](#1-visão-das-camadas)
2. [ADR — Clean Architecture e Ports and Adapters](#2-adr--clean-architecture-e-ports-and-adapters)
3. [ADR — TypeORM versus MikroORM](#3-adr--typeorm-versus-mikroorm)
4. [ADR — Unit of Work](#4-adr--unit-of-work)
5. [ADR — SELECT FOR UPDATE versus Optimistic Locking](#5-adr--select-for-update-versus-optimistic-locking)
6. [ADR — Outbox e Inbox](#6-adr--outbox-e-inbox)
7. [ADR — SQS FIFO versus Standard](#7-adr--sqs-fifo-versus-standard)
8. [ADR — Exactly-once versus At-least-once](#8-adr--exactly-once-versus-at-least-once)
9. [ADR — Money: Decimal versus bigint](#9-adr--money-decimal-versus-bigint)
10. [Canonical Payload Hash](#10-canonical-payload-hash)
11. [Failure Codes](#11-failure-codes)
12. [Autenticação (desenho futuro)](#12-autenticação-desenho-futuro)
13. [IntegrationEvent versus DomainEventEnvelope](#13-integrationevent-versus-domaineventenvelope)
14. [Status PENDING e FAILED no schema](#14-status-pending-e-failed-no-schema)
15. [API HTTP e códigos](#15-api-http-e-códigos)
16. [Workers, PENDING_REFERENCE, shutdown, métricas](#16-workers-pending_reference-shutdown-métricas)
17. [Fluxos OPENING e LOSS](#17-fluxos-opening-e-loss)
18. [Reversões REFUND / ROLLBACK](#18-reversões-refund--rollback)
19. [Limitações conhecidas](#19-limitações-conhecidas)
20. [Pontos sem comprovação / não inventados](#20-pontos-sem-comprovação--não-inventados)

---

## 1. Visão das camadas

| Camada | Responsabilidade | Local |
|--------|------------------|--------|
| **domain** | Entidades, VOs (`Money`), erros, portas de repositório, envelopes tipados | `src/domain/` |
| **application** | Use cases, ports (`UnitOfWork`, `MessageBus`, `MetricsPort`, …), workers de mensageria | `src/application/` |
| **infrastructure** | TypeORM, SQS, logging, env, Prometheus, ops CLI | `src/infrastructure/` |
| **composition** | Wiring único | `src/composition/create-app-composition.ts` |
| **api** | Controllers Nest, DTOs, filtros, guards | `src/api/` |

NestJS vive em **api** (+ bootstrap). Domínio e application **não** importam `@nestjs/*`.

---

## 2. ADR — Clean Architecture e Ports and Adapters

### Problema

Misturar HTTP, ORM e regras financeiras no mesmo módulo torna impossível testar concorrência/idempotência sem Nest/SQS e facilita vazar `number`/SQL para o núcleo financeiro.

### Decisão

Separar **Domain → Application → Infrastructure**, com **ports** na application e **adapters** na infrastructure. Controllers Nest só traduzem HTTP ↔ use cases montados em `createAppComposition`.

### Por que Nest não deve vazar para Domain

- O VO `Money` e as entidades devem permanecer testáveis sem DI Nest (`src/domain/money/money.ts`).
- Decorators ORM ficam em `*.orm-entity.ts`; o domínio usa factories (`open` / `rehydrate`).
- Controllers dependem de use cases; use cases dependem de ports — não o contrário.

### Trade-offs da abstração

| Prós | Contras |
|------|---------|
| Testes unitários com fakes de `UnitOfWork` / repos | Mais arquivos e mapping ORM ↔ domínio |
| Troca de adapter (SQS, métricas) sem reescrever use case | Risco de “over-port” se cada detalhe virar interface |
| Composition root explícito | Wiring concentrado em um arquivo |

### Evidência

- Ports (application):
  - `src/application/ports/unit-of-work.ts` — `UnitOfWork`
  - `src/application/ports/message-bus.ts` — `MessageBus`
  - `src/application/ports/metrics.ts` — `MetricsPort`
  - `src/application/ports/messaging-logger.ts` — `MessagingLogger`
  - `src/application/ports/dependency-health.ts` — `DependencyHealthPort`
- Composition: `src/composition/create-app-composition.ts`
- Domínio sem Nest: `src/domain/**`

---

## 3. ADR — TypeORM versus MikroORM

### Contexto do contrato (§4)

O desafio marca **MikroORM como preferencial** (UoW / Identity Map / `LockMode` explícitos) e **aceita TypeORM**. Prisma está fora de escopo.

### Decisão real

Este repositório usa **TypeORM 0.3.x**.

### Justificativa comprovada (sem inventar)

1. **Familiaridade da equipe** no momento da escolha (registrada nas notas iniciais do projeto) — motivo pragmático de timebox, não vantagem técnica intrínseca.
2. **Capacidade comprovada na implementação:**
   - transações via `DataSource.transaction` (`TypeOrmUnitOfWork`);
   - repositórios ligados ao `EntityManager` da TX;
   - migrations versionadas e reversíveis em `src/infrastructure/database/migrations/`;
   - lock pessimista `setLock('pessimistic_write')` na wallet.

### O que **não** afirmamos

- Não afirmamos superioridade de performance, Identity Map ou DX sobre MikroORM.
- Não há evidência no código de avaliação formal MikroORM vs TypeORM além da aceitação contratual.

### Trade-offs

| TypeORM (adotado) | MikroORM (preferência do desafio, não adotado) |
|-------------------|-----------------------------------------------|
| UoW **manual** (`TypeOrmUnitOfWork` + repos por manager) | UoW/`EntityManager.transactional` mais idiomático |
| Lock via QueryBuilder | `LockMode` de primeira classe |
| Migrations TypeORM já no fluxo `migration:run/revert` | Teria exigido stack e mapeamento diferentes |

### Evidência

- `package.json` → `typeorm`
- `src/infrastructure/unit-of-work/typeorm-unit-of-work.ts`
- `src/infrastructure/repository/wallet/typeorm-wallet.repository.ts`
- `src/infrastructure/database/data-source.ts`

---

## 4. ADR — Unit of Work

### Problema

Wallet, ledger, wager_transaction, inbox e outbox precisam commit/rollback **juntos**. Publicar no SQS **antes** do commit viola a restrição §5.4 do contrato.

### Como a transação é iniciada e encerrada

`TypeOrmUnitOfWork.run` chama `dataSource.transaction(async (manager) => …)`.  
Sucesso do callback → COMMIT; exceção → ROLLBACK.

```text
unitOfWork.run(repos => { … })  →  DataSource.transaction(manager)
```

### Como os repositories participam

`createTransactionalRepositories(manager)` instancia TypeORM repos com `manager.getRepository(...)` (e passa `manager` onde há SQL raw / claim). Todos compartilham a **mesma** conexão/TX.

### Outbox e Inbox na atomicidade

- **HTTP / PlaceBet etc.:** na mesma `run`, persistem wallet/ledger/tx e `outboxMessages.save(...)`.
- **Inbound SQS:** `inboxMessages.tryInsert` + `SubmitWagerTransactionUseCase.executeWithRepos` na mesma `run`; ACK só **depois** do commit (`InboundWagerConsumer`).
- **Inbox de domain events:** padrão análogo em `InboxConsumer`.

### Comparação com MikroORM

MikroORM exporia UoW/Identity Map no `EntityManager` da lib. Aqui o port `UnitOfWork` é fino: só `run(work)`. Não há Identity Map de domínio — cada `find` reidrata via mapper.

### Evidência

- `src/infrastructure/unit-of-work/typeorm-unit-of-work.ts`
- `src/application/messaging/inbound-wager-consumer.ts` (`tryInsert` + `executeWithRepos`)
- Use cases: `src/application/use-cases/wager/place-bet.use-case.ts` (save outbox na TX)

---

## 5. ADR — SELECT FOR UPDATE versus Optimistic Locking

### Problema

Duas BET de `80.00` na mesma wallet com saldo `100.00` não podem ambas debitar (cenário obrigatório §8). `read → calculate → update` sem controle é falha eliminatória.

### Decisão

**Lock pessimista** na linha da wallet: `SELECT … FOR UPDATE` via TypeORM `setLock('pessimistic_write')` em `findByIdForUpdate`, dentro da UoW.

### Como evita lost updates

A segunda transação **espera** o unlock da primeira. Após a primeira debitar, a segunda lê o saldo já atualizado e rejeita com `INSUFFICIENT_FUNDS` se não couber.

### Concorrência entre apostas

Unidade de concorrência = `walletId` (contrato §8). Wallets distintas não compartilham a mesma linha — processam em paralelo. Não há lock global.

### Papel real de `wallet.version`

- Inicia em `1` na abertura (`Wallet.open`).
- Incrementa em `credit` / `debit` **somente quando o saldo muda** (`src/domain/wallet/wallet.entity.ts`).
- É persistido e exposto (API / evento `WalletBalanceChanged.walletVersion` / snapshot `observed_wallet_version`).

**`version` não implementa CAS nem optimistic locking.**  
Não há `UPDATE … WHERE version = $expected`. A concorrência correta depende do **FOR UPDATE**, não do campo `version`.

### Trade-offs

| Pessimista (adotado) | Optimistic (não adotado como mecanismo) |
|----------------------|------------------------------------------|
| Serializa hot wallet; sem retry de versão | Mais throughput sob baixa contenção; exige retry |
| Risco de espera/lock wait sob carga | `version` sozinho não bastaria sem CAS |

### Evidência

- `TypeOrmWalletRepository.findByIdForUpdate` — comment: “lock pessimista evita lost update sem retry de version”
- `PlaceBetUseCase` chama `findByIdForUpdate` antes de debitar
- `Wallet.credit` / `debit` incrementam `_version` sem WHERE version

---

## 6. ADR — Outbox e Inbox

### Problema (dual write)

Gravar no Postgres e publicar no SQS em dois passos sem atomicidade: crash entre eles perde evento ou publica sem efeito financeiro.

### Alternativas consideradas (não adotadas como caminho principal)

| Alternativa | Motivo de não usar como garantia |
|-------------|----------------------------------|
| **Publish in-process** após commit | Ainda há janela crash pós-commit pré-publish; sem tabela, recuperação é ad hoc |
| **CDC** (WAL → fila) | Fora do escopo local; complexidade operacional maior que o desafio pede |

### Por que Outbox

Na **mesma TX** financeira, grava-se `outbox_message`. Um publisher separado faz claim (`FOR UPDATE SKIP LOCKED` + `locked_until`), publica no bus e só então `markPublished`. Crash pré-publish → outra instância reclama após lease.

### Inbox

Consumidores deduplicam por **`(consumer_name, message_id)`** (`tryInsert`). Redelivery at-least-once não duplica efeito se a primeira execução já commitou.

### Intervenção (E2.3.5)

- `attempts` sobe no **claim** (não só em falha de publish). Claims abandonados (crash/shutdown) podem elevar `attempts` **sem** gerar intervenção.
- **`attempts >= 10` isoladamente não pausa** o evento.
- Após **falha de publicação**, se `attempts >= 10`, o publisher registra intervenção (`markInterventionRequired`) e preenche **`intervention_required_at`**.
- O **estado de pausa** é `intervention_required_at` preenchido. O claim SQL exclui essas linhas (`intervention_required_at IS NULL`).
- Backoff antes do limiar: `next_attempt_at = now + min(300, 2^attempts)` após falha de publish.
- Recuperação: `ClearOutboxInterventionUseCase` / `bun run ops:clear-outbox-intervention` (não zera `attempts`).

Detalhes: [`docs/OUTBOX_INTERVENTION_RUNBOOK.md`](docs/OUTBOX_INTERVENTION_RUNBOOK.md).

### Trade-offs at-least-once

- Evento pode ser publicado mais de uma vez se crash entre publish e `markPublished`.
- Consumidor **deve** ser idempotente (Inbox). Não prometemos exactly-once de entrega.

### Evidência

- Claim: `src/infrastructure/repository/outbox/typeorm-outbox-message.repository.ts`
- Publisher: `src/application/messaging/outbox-publisher.ts`
- Inbox: `src/application/messaging/inbox-consumer.ts`, `inbound-wager-consumer.ts`

---

## 7. ADR — SQS FIFO versus Standard

### Inbound — FIFO (`jungle-wager-transactions.fifo`)

**Por quê:** contrato §10 exige fila `.fifo` (+ DLQ) para `WagerTransactionRequested`. Ordenação por grupo e deduplicação de broker são **otimização**, não a garantia final (banco + Inbox continuam soberanos).

**MessageGroupId:** em publish FIFO, `SqsMessageBus` usa `attributes.messageGroupId` → senão `attributes.walletId` → senão `'default'`. Testes inbound usam `wallet.id` como group — alinha com unidade de concorrência `walletId`.

**MessageDeduplicationId:** `message.id` (id da mensagem de negócio). A fila local também habilita `ContentBasedDeduplication` em `docker/localstack/init-sqs.sh`.

### Domain events — Standard (`jungle-wager-events`)

**Por quê (implementação real):** fila de eventos criada na Fase B como standard e mantida; o contrato §10 detalha a FIFO de **entrada de apostas**, não obriga FIFO na fila de integração outbox neste ambiente. Consumers de eventos dependem de **Inbox**, não de ordenação FIFO global.

### Trade-offs

| FIFO inbound | Standard events |
|--------------|-----------------|
| Ordenação por `MessageGroupId`; throughput por grupo | Maior paralelismo entre mensagens |
| Dedup de broker complementar | Dedup só via Inbox + ids estáveis |

### Evidência

- `docker/localstack/init-sqs.sh`
- `src/infrastructure/messaging/sqs-message-bus.ts` (bloco `fifo`)
- `src/infrastructure/messaging/sqs.env.ts`

---

## 8. ADR — Exactly-once versus At-least-once

### Por que não prometemos exactly-once

SQS e o outbox worker oferecem **at-least-once**. Exactly-once ponta a ponta exigiria broker transacional + consumidor sem side effects duplicáveis de forma absoluta — fora do modelo adotado.

### Crash pós-commit e pré-ACK

1. Inbound/Inbox commitam efeito + inbox na UoW.
2. Processo morre antes do `ack`.
3. SQS redelivery → `tryInsert` falha (duplicata) → ACK sem reaplicar efeito.

### Crash pós-publish e pré-`markPublished`

1. Outbox já enviou ao SQS.
2. Processo morre antes de `markPublished`.
3. Lease expira → outro publisher republica o mesmo `eventId`.
4. Consumer Inbox deduplica por `(consumer_name, message_id)` / event id.

### Como a idempotência protege efeitos

- **HTTP / negócio:** `Idempotency-Key` + `payload_hash` únicos por provider; replay devolve resultado original.
- **Mensageria:** Inbox persistente.
- **Uniques PG:** idempotency key, external id, reversão PROCESSED.

### Evidência

- Shutdown / abandon: `ARCHITECTURE` seção 16 + `MessagingWorkersHost` / `shutdownGate`
- Publisher comments em `outbox-publisher.ts`
- Multi-instance e messaging e2e cobrem crash/redelivery

---

## 9. ADR — Money: Decimal versus bigint

### Por que `decimal.js` na aritmética

`Money` usa `Decimal` com `precision: 28` e `ROUND_HALF_UP` (`src/domain/money/money.ts`). Operações `add` / `subtract` / `negate` retornam novas instâncias. Entrada e JSON usam **string** decimal escala 2 — nunca `number`.

### Onde `bigint` é utilizado

Somente em `src/shared/money-limits.ts` (`amountToAbsCents`) para comparar magnitude com o teto `NUMERIC(19,2)` **sem** float. Não é o motor de aritmética do domínio.

### Por que `number` não serve

IEEE-754 não representa decimais financeiros de forma exata (`0.1 + 0.2`). Contrato: falha eliminatória usar `number`/`float`/`double` para dinheiro.

### Limites `NUMERIC(19,2)`

- Persistência: colunas `numeric(19,2)` (migration `AlignMonetaryNumericScaleNineteenTwo`).
- Magnitude máx. documentada: `99999999999999999.99` (`MONEY_MAX_ABS_AMOUNT`).
- **Limitação PG:** `NUMERIC(19,2)` **arredonda** (não rejeita) >2 casas no INSERT/UPDATE. Rejeição obrigatória fica em `Money` / `MoneyDto`.

### Evidência

- `src/domain/money/money.ts`
- `src/shared/money-limits.ts`
- `src/api/http/money.dto.ts`

---

## 10. Canonical Payload Hash

Implementação: `src/application/wager/canonical-payload-hash.ts`.

### Algoritmo

1. Monta objeto de negócio tipado.
2. `canonicalJsonStringify` → `JSON.stringify` após **ordenar chaves recursivamente** (`Object.keys(record).sort()`).
3. `createHash('sha256').update(canonical, 'utf8').digest('hex')`.

### Campos incluídos (BET / WIN / LOSS)

`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `amount`, `currency`.

### Campos adicionais (REFUND / ROLLBACK)

Os mesmos + `referenceExternalTransactionId`.

### Normalização

Não há normalização monetária extra no hash além dos strings já validados pelo use case / `Money.from`. Shape flat `amount`+`currency` (não aninha `money: {…}`) para não invalidar hashes já persistidos.

### Campos excluídos

- Header `Idempotency-Key` e metadados de transporte.
- Qualquer campo não listado no tipo `ExternalWagerBusinessPayload`.

### Detecção de reuso de key com payload diferente

1. Busca por `(providerId, idempotencyKey)`.
2. Se existe e `existing.payloadHash !== payloadHash` → `IdempotencyPayloadConflictError` → HTTP **409**.
3. Se hash igual → cada kind (PlaceBet / SettleWin / …) devolve o snapshot original via `buildReplayFromExisting` (sem novos side effects).
4. O flag **`idempotentReplay: true`** é definido no **`SubmitWagerTransactionUseCase`** (quando há resultado prévio do kind / replay), **não** no PlaceBet isoladamente. A saída HTTP/métricas do Submit expõem esse campo.

### Evidência

- Hash: `canonical-payload-hash.ts`
- Comparação por kind: `*UseCase.buildReplayFromExisting` (ex.: `PlaceBetUseCase`)
- Flag de replay na API: `SubmitWagerTransactionUseCase` (`idempotentReplay`)

---

## 11. Failure Codes

Fonte: `src/domain/wager-transaction/failure-codes.ts`.

### Taxonomia implementada

| Código | Categoria | Quando |
|--------|-----------|--------|
| `INSUFFICIENT_FUNDS` | Rejeição de negócio | BET sem saldo |
| `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` | Rejeição de negócio | ROLLBACK deixaria saldo &lt; 0 |
| `REFERENCE_NOT_FOUND` | Referência inválida / ausente | Após TTL 24h sem referência |
| `INVALID_REFERENCE_TYPE` | Referência inválida | Kind da referência não permitido |
| `REFERENCE_SCOPE_MISMATCH` | Referência inválida | provider/player/wallet/currency/round divergem |
| `REFERENCE_AMOUNT_MISMATCH` | Referência inválida | amount ≠ referência |
| `REFERENCE_NOT_PROCESSED` | Referência inválida | Referência existe mas não `PROCESSED` |
| `REFERENCE_ALREADY_REVERSED` | Conflito | Já existe reversão `PROCESSED` (REFUND **ou** ROLLBACK) da mesma ref |

### Falhas de processamento (infra)

**Não há `failureCode` de infraestrutura nesta taxonomia.** Erros transitórios de SQS/Postgres não gravam status `FAILED` no domínio (ver §14). Caminho: retry de visibilidade / DLQ após `maxReceiveCount`, ou intervenção Outbox.

### Persistência e API

- Persistidos em `wager_transaction.failure_code` quando status = `REJECTED`.
- Submit HTTP: rejeição de negócio (pré-check) → **200** + body com `status: REJECTED` e `failureCode` (não 4xx de negócio).
- `PENDING_REFERENCE` → **202**; `REFERENCE_NOT_FOUND` só após TTL (não no aceite pendente).
- Conflitos de idempotência/id externo → **409** (erros de aplicação, não `failureCode` de negócio).
- Race UNIQUE de reversão já existente: ver §18 — o caminho HTTP via Submit **não** tem a mesma semântica que `RefundWagerUseCase.execute` / `persistRejectedAfterRace`.

---

## 12. Autenticação (desenho futuro)

### Estado atual (implementado)

- **Não** há IdP. Decisão alinhada ao contrato §2 (sem pontos na rubrica).
- `NoopAuthGuard` (`src/api/auth/noop-auth.guard.ts`): `canActivate` sempre `true`.
- Registrado como `APP_GUARD` em `app.module.ts` e `@UseGuards(NoopAuthGuard)` em wallets/wagering.
- Health permanece aberto (mesmo com guard no-op).
- `ProviderIdentityPort` define `resolveProviderId(authorizationHeader?)` — **porta sem adapter OIDC implementado**.

### Desenho futuro (não implementado — planejamento)

1. Substituir `NoopAuthGuard` por guard que valide JWT/OIDC (Keycloak ou Zitadel no Compose).
2. Validação do token no **edge HTTP** (guard Nest), antes do use case.
3. Adapter `ProviderIdentityPort` lê claims (`azp` / `client_id` / claim custom) e resolve `providerId` confiável.
4. Controllers **deixam de confiar** em `providerId` livre do body como identidade: body pode repetir o id apenas para auditoria; a autorização compara claim ≠ body → 403.
5. Filas continuam canal interno (contrato); identidade do provider na mensagem inbound ainda passa pelas validações de domínio, mas a origem HTTP fica autenticada.

**Não afirmamos** que Keycloak/Zitadel já rodam neste Compose.

---

## 13. IntegrationEvent versus DomainEventEnvelope

### Contrato (§11)

Esqueleto com classe abstrata `IntegrationEvent<T>` e subclasses (`WalletBalanceChanged`, …) com `eventType`/`version` no tipo.

### Implementação real

- Tipo `DomainEventEnvelope` em `src/domain/events/domain-event.ts` (campos: `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt` ISO string, `version`, `data`).
- Builders em `src/application/events/*` produzem envelopes tipados (`WagerTransactionProcessedEvent`, etc.).
- Persistência outbox: `OutboxMessage.fromEnvelope(envelope)` grava o JSON do envelope.

### Justificativa da escolha real

Priorizou-se um **envelope JSON estável e versionável** com tipagem TypeScript (`DomainEventEnvelope<'WalletBalanceChanged', …>`) e factories de aplicação, sem hierarquia de classes no domínio. O contrato dos **campos** do envelope e dos `data` (MoneyProps em string) é preservado.

### Vantagens / trade-offs

| Type envelope (adotado) | Classes abstratas (contrato esqueleto) |
|-------------------------|----------------------------------------|
| Serialização direta; menos boilerplate | `eventType`/`version` amarrados à classe |
| Fácil de persistir em jsonb | Polimorfismo OO mais explícito |
| Desvio do esqueleto do README do desafio | Pode exigir explicação na apresentação |

**Não alteramos** o modelo de eventos nesta documentação.

---

## 14. Status PENDING e FAILED no schema

### Schema (CHECK)

Migration `002-Create_table_wager_transaction` permite:

`PENDING` | `PENDING_REFERENCE` | `PROCESSED` | `REJECTED` | `FAILED`

### Domínio (tipo TypeScript)

`WagerTransactionStatus` = **somente**  
`PENDING_REFERENCE` | `PROCESSED` | `REJECTED`  
(`src/domain/wager-transaction/wager-transaction.entity.ts`).

Não há método `fail()` nem factory que produza `FAILED` ou `PENDING` no domínio atual. Fluxos externos nascem direto em `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`.

### Evidências de “não usado pelo domínio”

- Migration `005-Add_failure_code_to_wager_transaction.ts` comenta: comportamento **FAILED não implementado** nesta migration.
- Helpers de teste podem inserir `PENDING` via SQL cru (`test/helpers/db.ts`) para constraints — isso **não** prova uso pelo domínio.
- Constraints e2e aceitam inserir `FAILED`/`PENDING` no PG porque o CHECK permite.

**Conclusão:** `PENDING` e `FAILED` no CHECK são **capacidade de schema / legado alinhado ao esqueleto do contrato**, não estados ativos do modelo de domínio atual.

---

## 15. API HTTP e códigos

| Método | Path | Status principais |
|--------|------|-------------------|
| POST | `/wallets` | 201 / 409 |
| GET | `/wallets/:walletId` | 200 / 404 |
| GET | `/wallets/:walletId/ledger?cursor&limit` | 200 / 404 |
| POST | `/wallets/:walletId/reconciliation` | 200 / 404 |
| POST | `/wagering/transactions` | 200 / 202 / 400 / 404 / 409 |
| GET | `/wagering/transactions/:transactionId` | 200 / 404 |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | 200 / 404 |
| GET | `/health/live` | 200 |
| GET | `/health/ready` | 200 / 503 (`DependencyHealthPort`) |
| GET | `/metrics` | 200 |

Mapeamento HTTP (contrato exige distinção clara, não códigos fixos):

- **400** — validação / payload / `Idempotency-Key` ausente  
- **404** — wallet ou transação inexistente (inclui wallet ausente em `POST /wagering/transactions`)  
- **409** — wallet duplicada; idempotência key + payload diferente; unique id externo; race UNIQUE de reversão no Submit (ver §18)  
- **200** — `PROCESSED` ou `REJECTED` (negócio no body)  
- **202** — `PENDING_REFERENCE`  
- **503** — readiness (deps / stopping)  
- **500** — inesperado (sem SQL/stack na resposta)

#### `/health/ready` (probe real)

Adapter `TypeOrmSqsDependencyHealth`:

1. PostgreSQL: `SELECT 1` via TypeORM `DataSource`.
2. SQS: `messageBus.receive(1, 0)` na fila **events** (bus principal / `SQS_MAIN_QUEUE_URL`).

Essa verificação **não** é consulta passiva / read-only: um `ReceiveMessage` pode afetar a **visibilidade** de uma mensagem (mesmo brevemente, conforme visibility timeout do receive). A fila **inbound FIFO** **não** é verificada por este probe.

Reconciliação: compara saldo materializado × Σ ledger; **não** corrige; log + métrica + resposta §9.

---

## 16. Workers, PENDING_REFERENCE, shutdown, métricas

### Workers (`WORKERS_ENABLED=true`)

Por processo (`MessagingWorkersHost`): Outbox publish, Inbox domain events, Inbound wager, worker PENDING_REFERENCE. Compose: `app-1..3` (3001–3003), `INSTANCE_ID` em `/health/live`.

### PENDING_REFERENCE (C2)

- TTL **24h** via `pending_reference_at`
- Backoff `next_attempt_at = now + min(300, 2^n)` (`n = pending_attempt_count` no **defer**, não no claim)
- Claim: `FOR UPDATE SKIP LOCKED` + `locked_until`
- Expiração → `REJECTED` + `REFERENCE_NOT_FOUND` + outbox na mesma UoW
- **Worker periódico:** `ProcessPendingReferencesUseCase` reclama pendências elegíveis e chama `ReprocessPendingReferencesUseCase`.
- **Gatilho Inbox:** ao consumir `WagerTransactionProcessed` (kinds `BET` / `WIN` / `REFUND` / `ROLLBACK`), `DomainEventHandler` (`src/application/messaging/domain-event-handler.ts`) chama `ReprocessPendingReferencesUseCase.executeWithRepos` com `externalReference = externalTransactionId` da linha processada — na **mesma UoW** do Inbox. Kinds `LOSS` e `OPENING` são ignorados por esse handler. Não inventa regras financeiras; só dispara o reprocesso já existente.

### Graceful shutdown (C3)

- `enableShutdownHooks` → drain workers (`SHUTDOWN_DRAIN_MS`) → `DataSource.destroy`
- Pré-ACK abort → redelivery; outbox claimada → `locked_until`
- `/health/ready` → 503 se `stopping` (probe: ver §15)

### Redrive SQS (LocalStack)

- Valor **efetivo** nas filas criadas pelo init: `maxReceiveCount = 5` **hardcoded** em `docker/localstack/init-sqs.sh`.
- `SQS_MAX_RECEIVE_COUNT` no `.env` alimenta `sqsEnv` (uso em testes que recriam atributos); **não** altera automaticamente uma fila já criada pelo init.

### Prometheus (D)

Porta `MetricsPort` + `safeMetrics`. Catálogo: [`docs/METRICS.md`](docs/METRICS.md).

---

## 17. Fluxos OPENING e LOSS

### OPENING (abertura de carteira)

`OpenWalletUseCase` (`POST /wallets`):

- Saldo inicial **zero:** persiste só a wallet; **sem** ledger, **sem** `wager_transaction`, **sem** outbox.
- Saldo inicial **&gt; 0:** na mesma UoW — wallet + `WagerTransaction` kind `OPENING` `PROCESSED` + lançamento de ledger **CREDIT** (0 → saldo inicial) + outbox `WagerTransactionProcessed` e `WalletBalanceChanged`.
- Sem `FOR UPDATE` (criação). Duplicata `(playerId, currency)` → conflito / HTTP **409**.

### LOSS

`SettleLossUseCase`:

- Amount deve ser **zero** (validação de negócio).
- Com `FOR UPDATE` na wallet para serializar com outros kinds; **não** altera saldo; **não** cria ledger; **não** emite `WalletBalanceChanged`.
- Persiste `wager_transaction` `LOSS` `PROCESSED` + outbox `WagerTransactionProcessed` (snapshot do saldo observado).

---

## 18. Reversões REFUND / ROLLBACK

Contrato §7.4: sem reverter duas vezes pelo **mesmo tipo**.

**Interpretação adicional implementada:** no máximo **uma** reversão `PROCESSED` (`REFUND` **ou** `ROLLBACK`) por `(providerId, external_reference)` — índice `UQ_wager_transaction_processed_reversal_ref` (migration 011). Impede crédito duplicado REFUND+ROLLBACK da mesma BET. `ROLLBACK` de um `REFUND` permanece válido (referência = id externo do REFUND).

### Race UNIQUE × caminhos de execução

Pré-check que encontra reversão `PROCESSED` → persiste `REJECTED` + `REFERENCE_ALREADY_REVERSED` → HTTP **200** (via Submit).

Se duas reversões correm em paralelo e a constraint UNIQUE dispara:

| Caminho | Comportamento atual |
|---------|---------------------|
| HTTP / `SubmitWagerTransactionUseCase.execute` | Propaga `ReferenceAlreadyReversedConflictError` → HTTP **409**; **não** persiste `REJECTED` nesse catch |
| `RefundWagerUseCase.execute` (direto) | `persistRejectedAfterRace` → `REJECTED` + `REFERENCE_ALREADY_REVERSED` |
| `RollbackWagerUseCase.execute` (direto) | Mesmo padrão de race handling que o Refund (persistência de rejeição após race) |
| Reprocess pending | Trata a race e pode persistir rejeição (`rejectAfterUniqueRace`) |

**Os caminhos não têm semântica HTTP idêntica.** Diferença registrada como limitação conhecida (§19) até decisão técnica posterior.

---

## 19. Limitações conhecidas

- OpenTelemetry tracing **não** implementado.
- Counters Prometheus zeram no restart do processo; DLQ depth é aproximada (SQS).
- Fila de **eventos** local permanece **standard**; inbound é FIFO.
- Auth IdP **não** implementada (apenas extensão).
- Status `FAILED` / `PENDING` no CHECK **sem** ciclo de vida no domínio.
- Intervenção Outbox é operacional via CLI, **sem** endpoint HTTP admin.
- Race UNIQUE REFUND/ROLLBACK: Submit HTTP pode responder **409** sem `REJECTED`; use case direto de Refund/Rollback pode persistir `REJECTED` — semânticas distintas (§18).
- `/health/ready` não é probe SQS read-only: usa `receive(1, 0)` na fila events; inbound FIFO fora do probe (§15).

---

## 20. Pontos sem comprovação / não inventados

| Afirmação | Status |
|-----------|--------|
| MikroORM seria mais rápido / melhor Identity Map neste projeto | **Não avaliado** no código |
| Optimistic locking via `version` | **Não implementado** |
| Exactly-once end-to-end | **Não prometido** |
| IdP Keycloak/Zitadel em Compose | **Só desenho futuro** |
| `ProviderIdentityPort` adapter real | **Só interface** |
| Uso de `FAILED` pelo domínio | **Sem evidência de uso** |
| Classes `IntegrationEvent` abstratas | **Não adotadas**; envelope tipado sim |

---

*Fim do ARCHITECTURE.md — E2.4.1.*
