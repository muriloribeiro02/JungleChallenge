# Testes

Documentação exclusiva dos scripts e da organização de testes deste projeto.

Política obrigatória (unitário + e2e + doc): ver [`skills/AGENTS.md`](../skills/AGENTS.md).

Sempre documentar quando houver uma atualização em teste neste arquivo.

## Scripts

| Script | Comando | O que faz |
|--------|---------|-----------|
| `test` | `bun run test` | Atalho legado do Nest: roda specs em `src/` (`*.spec.ts`) |
| `test:unit` | `bun run test:unit` | Roda testes **unitários** em `test/**/*.spec.ts` |
| `test:e2e` | `bun run test:e2e` | Roda testes **e2e** em `test/**/*.e2e-spec.ts` (pode usar Postgres) |
| `test:all` | `bun run test:all` | Roda unitários e e2e em sequência |
| `test:watch` | `bun run test:watch` | Jest em modo watch (specs em `src/`) |
| `test:cov` | `bun run test:cov` | Cobertura dos specs em `src/` |
| `test:debug` | `bun run test:debug` | Jest com inspector Node para debug |

### Filtrar por nome

```bash
bun run test:unit -- wallet.entity
bun run test:unit -- wallet.migration
bun run test:e2e -- wallet.constraints
bun run test:e2e -- wallet.migration
```

## Organização

```
test/
  helpers/
    db.ts                      # conexão Postgres + insertWallet
    migration-data-source.ts   # DataSource TypeORM para testes de migration
  money/
    money.spec.ts              # unit: precisão e moeda em Money.from
  wallet/
    wallet.entity.spec.ts           # unit: criação/validação da entidade
    wallet.constraints.e2e-spec.ts  # e2e: constraints da tabela wallet
    wallet.migration.spec.ts        # unit: SQL up/down da migration
    wallet.migration.e2e-spec.ts    # e2e: ida e volta (revert + run)
  app.e2e-spec.ts
  jest-unit.json
  jest-e2e.json
```

## Suíte atual — money / wallet

| Arquivo | Tipo | Cobre |
|---------|------|-------|
| `money/money.spec.ts` | unit | `Money.from`: escala ≤2 casas, rejeição de `number`, moedas inválidas/normalização |
| `wallet.entity.spec.ts` | unit | `Wallet.open` / `rehydrate`: version=1, saldo `Money`, rejeição de saldo negativo e ids inválidos |
| `wallet.constraints.e2e-spec.ts` | e2e | CHECK, UNIQUE, PK, NOT NULL |
| `wallet.migration.spec.ts` | unit | `up`/`down` da `CreateWalletTable` |
| `wallet.migration.e2e-spec.ts` | e2e | revert remove tabela; run recria e registra em `migrations` |

## Requisitos por feature

Toda feature nova precisa de:

1. **Unitário** (`*.spec.ts`) — validação/domínio/use case isolado
2. **E2E** (`*.e2e-spec.ts`) — comportamento integrado (API e/ou banco)
3. **Doc** — atualizar este arquivo descrevendo o que mudou

## Banco nos e2e

- Postgres via Docker: `docker compose up -d postgres`
- Porta do app: ver `DATABASE_PORT` no `.env` (ex.: `5434`)
- Preferir `BEGIN`/`ROLLBACK` por teste para não sujar dados
- Testes de migration alteram schema de verdade e devem restaurar o estado no `afterAll`

## Configs Jest

| Arquivo | Uso |
|---------|-----|
| `test/jest-unit.json` | Unitários (`test:unit`) |
| `test/jest-e2e.json` | E2E (`test:e2e`) |
| `package.json` → `jest` | Config padrão do Nest para specs em `src/` |
