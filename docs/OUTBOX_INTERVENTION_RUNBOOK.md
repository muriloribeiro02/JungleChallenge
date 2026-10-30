# Runbook — Outbox Intervention Policy (E2.3.5)

Runbook geral (filas, DLQ, PENDING_REFERENCE, ready): [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md).

## Objetivo

Evitar retries infinitos sem visibilidade, preservando **at-least-once** e **sem descartar** eventos. A partir de **10 attempts**, o evento deixa de ser claimável automaticamente até recuperação operacional controlada.

## Conceitos

| Campo | Significado |
|-------|-------------|
| `attempts` | Incrementado no **claim** (não só em falha de publish). Pode incluir claims abandonados por crash/shutdown. |
| `next_attempt_at` | Backoff `min(300, 2^attempts)` segundos após falha (antes do limiar). |
| `last_error` / `last_failed_at` | Última falha sanitizada (sem credenciais/tokens/payload financeiro). |
| `intervention_required_at` | Pausa operacional; claim automático excluído. |

Limiar: `OUTBOX_INTERVENTION_ATTEMPT_THRESHOLD = 10` (`src/domain/outbox/outbox-intervention.policy.ts`).

## Sinais

### Logs estruturados

- `outbox.publish_failed` — falha de publish (sempre; inclui `attempts`, `nextAttemptAt` ou `interventionRequired`).
- `outbox.intervention_required` — **uma vez** por evento (UPDATE atômico).
- `outbox.intervention_cleared` — após recuperação manual.

### Métricas (Prometheus)

| Métrica | Tipo |
|---------|------|
| `dwp_outbox_intervention_required_events` | Gauge PG (cache ~10s) |
| `dwp_outbox_high_attempt_events` | Gauge PG — unpublished com `attempts >= 10` |
| `dwp_outbox_pending_events` | Gauge — todos unpublished (inclui pausados) |
| `dwp_outbox_events_publish_failures_total` | Counter |

Sem label `eventId`.

```promql
max(dwp_outbox_intervention_required_events)
max(dwp_outbox_high_attempt_events)
```

## Investigação

1. Confirmar gauge / log `outbox.intervention_required`.
2. Localizar o evento (psql — ver [`OPS_RUNBOOK.md`](OPS_RUNBOOK.md) conexão PostgreSQL):

```sql
SELECT id, event_type, attempts, last_error, last_failed_at,
       intervention_required_at, locked_until, next_attempt_at, published_at,
       occurred_at
FROM outbox_message
WHERE intervention_required_at IS NOT NULL
ORDER BY intervention_required_at ASC;
```

3. Inspecionar causa em `last_error` (já sanitizado) e saúde do bus (SQS/LocalStack).
4. **Não** apagar a linha. **Não** forçar `published_at` sem ter certeza da publicação.
5. Após corrigir a causa raiz (rede, fila, permissões), liberar o evento.

## Recuperação (sem HTTP público)

### Pré-condições do CLI

Antes de `ops:clear-outbox-intervention`:

1. Arquivo `.env` configurado a partir de `.env.example`, incluindo **`DATABASE_PASSWORD`** (obrigatório em `databaseEnv`).
2. PostgreSQL disponível (container `jungle-postgres` healthy / host em `DATABASE_HOST`:`DATABASE_PORT`).
3. Migrations aplicadas (`bun run migration:run` / `migration:show`).
4. Evento alvo: existe por `id` (= `eventId`), **`published_at` IS NULL**, e **`intervention_required_at` IS NOT NULL**.
5. **Corrigir a causa da falha de publicação no SQS** (LocalStack/fila/rede) **antes** do clear — senão o publisher pode falhar de novo e o evento voltar a exigir intervenção (ver abaixo).

### Comando

```bash
bun run ops:clear-outbox-intervention -- <eventId-uuid>
```

Fonte: `package.json` → `ops:clear-outbox-intervention` → `src/infrastructure/ops/clear-outbox-intervention.cli.ts`  
(`process.argv[2]` = UUID; o `--` do `bun run` encaminha o argumento ao script).

### Efeitos (quando sucesso)

- Remove `intervention_required_at`
- Define `next_attempt_at = now()`
- **Não** zera `attempts`
- **Não** altera `payload` nem `id` / `eventId`
- Log `outbox.intervention_cleared`

Use case: `ClearOutboxInterventionUseCase` (`createAppComposition.clearOutboxIntervention`).

### Erros possíveis (use case / CLI)

| Situação | Erro (classe) | Mensagem típica no stderr |
|----------|---------------|---------------------------|
| ID inexistente | `OutboxEventNotFoundError` | `Outbox event not found: …` |
| Sem `intervention_required_at` (ou race de clear) | `OutboxEventNotAwaitingInterventionError` | `Outbox event is not awaiting intervention: …` |
| Já publicado | `OutboxEventAlreadyPublishedError` | `Outbox event already published (immutable): …` |
| UUID inválido / ausente | validação do CLI | `Uso: ops:clear-outbox-intervention <eventId-uuid>` |

Classes: `src/domain/outbox/outbox-intervention.errors.ts`.

## Pós-recuperação

O publisher volta a poder claimar o evento. Como **`attempts` permanece alto** (sem reset), se a publicação falhar de novo o limiar (≥ 10) continua satisfeito e o fluxo pode **marcar nova intervenção** imediatamente após a falha. Por isso a causa raiz no SQS deve estar corrigida antes do clear.

Após publish bem-sucedido → `published_at`; redelivery posterior é coberta pelo Inbox (at-least-once).

## Anti-padrões

- Endpoint HTTP de admin público para clear
- `DELETE` do outbox / marcar published em falha
- Reset automático de `attempts` no clear
- Classificar todo HTTP 4xx como permanente sem classificação explícita
