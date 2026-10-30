# Runbook operacional — DWP

Procedimentos para diagnóstico local (Docker Compose + LocalStack).  
Só usa nomes, URLs e comandos presentes no repositório.

Documentos relacionados:

- Intervenção Outbox: [`OUTBOX_INTERVENTION_RUNBOOK.md`](OUTBOX_INTERVENTION_RUNBOOK.md)
- Métricas: [`METRICS.md`](METRICS.md)
- Arquitetura: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)

## Inventário rápido

| Recurso | Valor comprovado |
|---------|------------------|
| Postgres container | `jungle-postgres` |
| LocalStack container | `jungle-localstack` |
| Porta SQS host | `4566` |
| Events queue | `jungle-wager-events` |
| Events DLQ | `jungle-wager-events-dlq` |
| Inbound FIFO | `jungle-wager-transactions.fifo` |
| Inbound DLQ | `jungle-wager-transactions-dlq.fifo` |
| URLs no `.env.example` | `SQS_*_QUEUE_URL` / `SQS_*_DLQ_URL` |
| `maxReceiveCount` efetivo (LocalStack) | **`5` hardcoded** em `docker/localstack/init-sqs.sh` (RedrivePolicy) |
| `SQS_MAX_RECEIVE_COUNT` | Env / `sqsEnv` (testes que recriam atributos); **não** altera fila já criada pelo init |
| Visibility | `30s` (`SQS_VISIBILITY_TIMEOUT_SECONDS`) |
| Outbox lease | `OUTBOX_CLAIM_LEASE_SECONDS` (default 60) |
| Clear Outbox | `bun run ops:clear-outbox-intervention -- <uuid>` |

`awslocal` é o CLI usado **dentro** da imagem LocalStack (`docker/localstack/init-sqs.sh`). No host, use `docker exec jungle-localstack awslocal …`.

### Conexão PostgreSQL (psql)

Usuário e banco vêm de `DATABASE_USER` e `DATABASE_NAME` no `.env`.  
Defaults do [`.env.example`](../.env.example): `jungle` / `jungle_db`.

```bash
# Substitua pelos valores do seu .env se diferentes dos defaults
docker exec -it jungle-postgres psql -U jungle -d jungle_db
```

As consultas SQL deste runbook assumem essa sessão `psql` (ou cliente equivalente apontando para a porta publicada em `DATABASE_PORT`).

---

## 1. Consultar fila principal e DLQ

### Sintoma

Métricas de DLQ sobem, ou eventos/apostas “somem” da fila principal.

### Investigar

**1.** Liste as URLs canônicas (não invente a URL à mão):

```bash
docker exec jungle-localstack awslocal sqs list-queues
```

Use no passo seguinte o valor exato retornado para cada fila (events, events-dlq, inbound fifo, inbound-dlq).

**2.** Inspecione profundidade **sem consumir** mensagens — `get-queue-attributes` só lê metadados:

```bash
# Exemplo: substitua QUEUE_URL pela URL impressa em list-queues
docker exec jungle-localstack awslocal sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible
```

Repita para as quatro filas. Contagens SQS são **aproximadas**.

Alternativa sem CLI: scrape `GET /metrics` — gauge `dwp_sqs_dlq_approximate_messages` (cache ~10s; aproximado).

**3. (Opcional)** `receive-message` — **não** é peek read-only.

- É operação de **consumo**: a mensagem é entregue ao caller e pode competir com workers (`app-*`).
- Só use com **`bun run apps:down`** (todas as aplicações interrompidas).
- `--visibility-timeout 0`: a mensagem volta a ficar visível imediatamente (não fica “escondida” pelo timeout padrão), mas **ainda é um receive** — não use como inspeção segura padrão.
- Visibility timeout &gt; 0 esconde a mensagem de outros consumidores até expirar (ou até delete/ACK).
- Este projeto **não** documenta `DeleteMessage` aqui; não apague mensagens da DLQ sem procedimento explícito.

```bash
bun run apps:down

docker exec jungle-localstack awslocal sqs receive-message \
  --queue-url "$QUEUE_URL_DLQ" \
  --max-number-of-messages 1 \
  --visibility-timeout 0
```

### Resultado esperado

- `list-queues` lista as quatro filas do init.
- `get-queue-attributes` mostra `ApproximateNumberOfMessages` ≥ 0; “in flight” em `NotVisible`.

### Cuidados

- Prefira sempre `list-queues` + `get-queue-attributes` para diagnóstico.
- Não há endpoint HTTP de admin para purgar filas neste projeto.

---

## 2. Mensagens que não são consumidas

### Sintoma

Outbox com `published_at` preenchido mas consumer não processa; ou inbound enfileirado e saldo não muda.

### Investigar

1. Apps com workers?

```bash
curl -s http://localhost:3001/health/live
# espera instanceId / workersEnabled (containers app-* usam WORKERS_ENABLED=true)
```

Com `bun run start:dev` e `WORKERS_ENABLED=false` no `.env`, **não** há poll de Inbox/Inbound/Outbox.

2. Ready:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health/ready
```

`503` → Postgres ou SQS indisponíveis (ou shutdown em curso).

3. Outbox ainda pendente no PG (via psql — ver conexão acima):

```sql
SELECT id, event_type, attempts, locked_until, next_attempt_at,
       published_at, intervention_required_at, last_error
FROM outbox_message
WHERE published_at IS NULL
ORDER BY occurred_at ASC
LIMIT 50;
```

4. Inbox já viu o id?

```sql
SELECT id, consumer_name, processed_at, transport_message_id
FROM inbox_message
ORDER BY received_at DESC
LIMIT 50;
```

5. Fila: mensagens só `NotVisible`? → visibility / processamento lento / hold de teste (`SHUTDOWN_TEST_HOLD_MS` deve ser `0` fora de teste). Use `get-queue-attributes`, não `receive-message`, para essa checagem.

### Resultado esperado

- Com workers ON e ready 200, outbox unpublished cai após publish; inbox registra processamento ou duplicata.

### Cuidados

- Não force `published_at` só para “limpar” a tabela.
- Entrega é **at-least-once**; duplicata no Inbox é esperada após redelivery.

---

## 3. PENDING_REFERENCE

### Sintoma

Submit/inbound retorna `PENDING_REFERENCE` (HTTP **202**); saldo ainda sem crédito/débito da reversão.

### Investigar

```sql
SELECT id, kind, status, provider_id,
       external_reference,
       pending_reference_at, next_attempt_at,
       pending_attempt_count, locked_until, failure_code
FROM wager_transaction
WHERE status = 'PENDING_REFERENCE'
ORDER BY pending_reference_at ASC NULLS LAST;
```

Comportamento (código + ARCHITECTURE):

- TTL **24h** a partir de `pending_reference_at`.
- Backoff: `next_attempt_at = now + min(300, 2^n)` s; `n = pending_attempt_count` incrementa no **defer**, não no claim.
- Worker periódico: `ProcessPendingReferencesUseCase` (intervalo `WORKER_PENDING_INTERVAL_MS` nos `app-*`).
- Gatilho Inbox: `DomainEventHandler` em `WagerTransactionProcessed` (BET/WIN/REFUND/ROLLBACK) chama `ReprocessPendingReferencesUseCase` na mesma UoW do Inbox (`externalReference` = `externalTransactionId` da tx processada). LOSS/OPENING não disparam esse caminho.
- Expiração → `REJECTED` + `failure_code = REFERENCE_NOT_FOUND` + evento Outbox.

### Resultado esperado

- Com a BET/referência chegando a tempo → reprocessa para `PROCESSED` (worker e/ou Inbox).
- Após TTL sem referência → `REJECTED` / `REFERENCE_NOT_FOUND`.

### Cuidados

- Não apague a linha `PENDING_REFERENCE` para “destravar”.
- Exigir workers ligados (`apps:up`) para o worker de pending **e** o Inbox de domain events rodarem.

---

## 4. Outbox em intervenção + clear CLI

Ver procedimento completo em [`OUTBOX_INTERVENTION_RUNBOOK.md`](OUTBOX_INTERVENTION_RUNBOOK.md).

Resumo:

| Item | Valor |
|------|--------|
| Sintoma | `intervention_required_at` preenchido; gauge `dwp_outbox_intervention_required_events` |
| `attempts` | Sobe no **claim**. Claims abandonados podem elevar `attempts` **sem** intervenção |
| Limiar | `attempts >= 10` **isoladamente não pausa**. Intervenção após **falha de publish** com `attempts >= 10` |
| Pausa | Estado = `intervention_required_at` preenchido; claim exige `intervention_required_at IS NULL` |
| Clear | `bun run ops:clear-outbox-intervention -- <eventId-uuid>` |
| Efeito | limpa intervenção; `next_attempt_at = now`; **não** reseta `attempts` nem payload |

### Cuidados

- Corrigir causa raiz (SQS/LocalStack) antes do clear.
- Gauge `dwp_outbox_high_attempt_events` (attempts ≥ 10 unpublished) **≠** necessariamente em intervenção.
- Sem endpoint HTTP de administração.

---

## 5. Retry, backoff, lease e redelivery

| Mecanismo | Onde | Comportamento comprovado |
|-----------|------|---------------------------|
| Outbox backoff | `next_attempt_at` | `min(300, 2^attempts)` segundos após falha de publish (&lt; limiar 10) |
| Outbox lease | `locked_until` | Claim define lease (`OUTBOX_CLAIM_LEASE_SECONDS`); crash → outra instância após expirar |
| Outbox intervenção | `intervention_required_at` | Pausa só com coluna preenchida (após falha de publish + attempts ≥ 10); claim exclui essas linhas |
| SQS visibility | fila | Default 30s; falha de consumer pode usar `ChangeMessageVisibility(0)` para redelivery rápida |
| SQS → DLQ | redrive | Após `maxReceiveCount` **5** do `init-sqs.sh` (não o env sozinho em fila já criada) |
| Inbox | `(consumer_name, message_id)` | Redelivery não reaplica efeito se já commitou |
| Pending backoff | `pending_attempt_count` | defer; TTL 24h prevalece |

Não há garantia **exactly-once** de entrega.

---

## 6. Inconsistência de saldo (reconciliação)

### Sintoma

Suspeita de divergência saldo × ledger.

### Investigar

```bash
curl -s -X POST http://localhost:3001/wallets/<wallet-uuid>/reconciliation
```

Resposta (contrato): `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`.

### Resultado esperado

- `consistent: true` em operação normal.
- `consistent: false` → divergência **sinalizada**; API **não** corrige. Há log/métrica de reconciliação (`dwp_reconciliation_*`).

### Cuidados

- Não “consertar” saldo com UPDATE manual sem auditoria.
- Use a reconciliação como diagnóstico, não como repair tool.

---

## 7. Dependências e readiness

### Sintoma

Load balancer / compose marca app unhealthy; ou API responde 503 em `/health/ready`.

### Investigar

```bash
curl -s http://localhost:3001/health/live
curl -s -i http://localhost:3001/health/ready
```

- **live 200** — processo no ar (mesmo se dependências caíram).
- **ready 503** — `DependencyHealthPort` falhou, ou app em shutdown (`stopping`).

O adapter `TypeOrmSqsDependencyHealth` (`/health/ready`):

1. Consulta PostgreSQL (`SELECT 1`).
2. Executa `messageBus.checkAvailable()` → `GetQueueAttributes` (`QueueArn`) na fila **events** — sem `ReceiveMessage` / sem alterar visibility.
3. A fila **inbound FIFO** **não** é verificada por esse probe.

Checagens de infra (`DATABASE_USER` / `DATABASE_NAME` do `.env`; defaults do `.env.example`: `jungle` / `jungle_db`):

```bash
docker compose ps
docker exec jungle-postgres pg_isready -U jungle -d jungle_db
curl -sf http://localhost:4566/_localstack/health
```

### Resultado esperado

Com postgres + localstack healthy e app iniciado: ready **200**.

### Cuidados

- Durante `apps:down` / SIGTERM, ready pode ir a 503 de propósito.
- Live **não** prova que a fila está consumindo.
- Prefira `get-queue-attributes`, não `receive-message`, para diagnóstico de profundidade da fila.

---

## 8. Lacunas (não inventado)

| Necessidade | Situação no repo |
|-------------|------------------|
| UI/admin para filas | Não existe |
| Script npm `sqs:purge` | Não existe |
| Endpoint HTTP clear-outbox | Não existe (só CLI) |
| Contador exato “mensagens enviadas à DLQ agora” | Só approximate + gauge cacheado |
| Comando `awslocal` no PATH do host Windows | Não garantido; use `docker exec jungle-localstack awslocal` |
