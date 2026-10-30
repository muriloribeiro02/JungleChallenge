# Runbook — Outbox Intervention Policy (E2.3.5)

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
2. Localizar o evento:

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

CLI operacional:

```bash
bun run ops:clear-outbox-intervention -- <eventId-uuid>
```

Efeito:

- Remove `intervention_required_at`
- Define `next_attempt_at = now()`
- Preserva `payload`, `id`/`eventId` e `attempts` (sem reset)
- Log `outbox.intervention_cleared`

Use case: `ClearOutboxInterventionUseCase` (também em `createAppComposition.clearOutboxIntervention`).

## Pós-recuperação

O publisher volta a claimar o evento (attempts continua alto). Se falhar de novo no limiar, pausa novamente. Após publish bem-sucedido → `published_at` e Inbox deduplica redelivery.

## Anti-padrões

- Endpoint HTTP de admin público para clear
- `DELETE` do outbox / marcar published em falha
- Reset automático de `attempts` no clear
- Classificar todo HTTP 4xx como permanente sem classificação explícita
