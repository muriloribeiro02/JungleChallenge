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
bun run test:unit -- wallet.mapper
bun run test:unit -- get-wallet-balance
bun run test:unit -- open-wallet.use-case
bun run test:unit -- place-bet.use-case
bun run test:unit -- settle-win
bun run test:unit -- settle-loss
bun run test:unit -- refund-wager
bun run test:unit -- rollback-wager
bun run test:unit -- refund-rollback.migration
bun run test:unit -- wager-transaction
bun run test:unit -- wallet-ledger-entry
bun run test:unit -- outbox-message.migration
bun run test:unit -- wallet.migration
bun run test:e2e -- wallet.constraints
bun run test:e2e -- open-wallet.use-case
bun run test:e2e -- place-bet.use-case
bun run test:e2e -- settle-win-loss
bun run test:e2e -- refund-rollback
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
    migration-data-source.ts   # DataSource TypeORM com migrations 001–007
  money/
    money.spec.ts              # unit: precisão e moeda em Money.from
  outbox/
    outbox-message.migration.spec.ts      # unit: SQL up/down outbox
    outbox-message.constraints.e2e-spec.ts # e2e: imutabilidade + campos operacionais
  wager-transaction/
    wager-transaction.entity.spec.ts      # unit: OPENING/BET/REFUND/ROLLBACK + snapshot
    wager-transaction.mapper.spec.ts      # unit: ORM ↔ domínio + snapshot
    wager-transaction.migration.spec.ts   # unit: SQL up/down wager_transaction
    wager-transaction-result-snapshot.migration.spec.ts # unit: SQL up/down 006 snapshot
    wager-transaction-result-snapshot.migration.e2e-spec.ts # e2e: 006 colunas, backfill, CHECKs
    refund-rollback.migration.spec.ts     # unit: SQL up/down 007 PENDING_REFERENCE + UNIQUE
    wager-transaction.constraints.e2e-spec.ts # e2e: status, amount, idempotência, moeda
  wager/
    place-bet.use-case.spec.ts / .e2e-spec.ts
    settle-win.use-case.spec.ts
    settle-loss.use-case.spec.ts
    settle-win-loss.use-case.e2e-spec.ts  # e2e: WIN/LOSS PG
    refund-wager.use-case.spec.ts         # unit: REFUND
    rollback-wager.use-case.spec.ts       # unit: ROLLBACK
    refund-rollback.use-case.e2e-spec.ts  # e2e: REFUND/ROLLBACK PG
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
    wallet.migration.e2e-spec.ts         # e2e: ida e volta 001–007
  jest-unit.json
  jest-e2e.json
```

## Suíte atual — money / wallet / financeiro (domínio)

| Arquivo | Tipo | Cobre |
|---------|------|-------|
| `money/money.spec.ts` | unit | `Money.from`: escala ≤2 casas, rejeição de `number`, moedas inválidas/normalização |
| `wallet.entity.spec.ts` | unit | `open` / `rehydrate` / `credit` / `debit`: version, moeda, saldo |
| `settle-win.use-case.spec.ts` | unit | WIN: crédito, ledger, eventos, idempotência, conflitos |
| `settle-loss.use-case.spec.ts` | unit | LOSS: amount 0, sem ledger, 1 evento, idempotência |
| `settle-win-loss.use-case.e2e-spec.ts` | e2e | WIN/LOSS PG: snapshot, race WIN×BET, rollback, external id |
| `refund-wager.use-case.spec.ts` | unit | REFUND: BET válida, WIN inválida, escopo/amount, PENDING_REFERENCE, duplicata, idempotência |
| `rollback-wager.use-case.spec.ts` | unit | ROLLBACK: BET/WIN/REFUND, saldo negativo, PENDING_REFERENCE, duplicata, idempotência |
| `refund-rollback.use-case.e2e-spec.ts` | e2e | REFUND/ROLLBACK PG: saldo, ledger, PENDING_REFERENCE, race duplicada, UNIQUE, atomicidade |
| `wallet.mapper.spec.ts` | unit | `WalletMapper` toPersistence/toDomain e round-trip sem `number` |
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
| `wager-transaction-result-snapshot.migration.e2e-spec.ts` | e2e | 006: ida/volta colunas; backfill `observed_balance`; version NULL; CHECKs |
| `wallet-ledger-entry.migration.spec.ts` | unit | `up`/`down` da `CreateWalletLedgerEntryTable` |
| `outbox-message.migration.spec.ts` | unit | `up`/`down` da `CreateOutboxMessageTable` |
| `wager-transaction.constraints.e2e-spec.ts` | e2e | status oficiais (+ inválido), amount por kind, idempotência/id externo por provedor, moeda |
| `wallet-ledger-entry.constraints.e2e-spec.ts` | e2e | moeda, bloqueio LOSS, UPDATE/DELETE imutáveis |
| `outbox-message.constraints.e2e-spec.ts` | e2e | payload/campos imutáveis; UPDATE operacional; DELETE não restringido pelo contrato |
| `wallet.repository.e2e-spec.ts` | e2e | `TypeOrmWalletRepository.save` / `findById` com Postgres real |
| `wallet.constraints.e2e-spec.ts` | e2e | CHECK, UNIQUE, PK, NOT NULL |
| `wallet.migration.spec.ts` | unit | `up`/`down` da `CreateWalletTable` |
| `wallet.migration.e2e-spec.ts` | e2e | revert em cascata 007→001; run recria 001–007 |

```bash
bun run test:unit -- wager-transaction-result-snapshot.migration
bun run test:e2e -- wager-transaction-result-snapshot.migration
bun run test:unit -- refund-rollback.migration
bun run test:e2e -- refund-rollback
```


> DELETE em `outbox_message`: contrato não exige bloqueio; migration e testes não inventam essa regra.

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
