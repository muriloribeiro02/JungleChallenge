# AGENTS.md

Instruções para **qualquer** agente de IA (Cursor, Claude, Codex, Copilot, Gemini, etc.).

## Regra obrigatória de testes

Sempre que montarmos alguma coisa, essa coisa tem que ter um teste unitario e um e2e.

Não considerar a tarefa concluída sem os dois.

| Tipo | Arquivo | Foco |
|------|---------|------|
| Unitário | `test/<contexto>/*.spec.ts` | Domínio, validação, use case isolado |
| E2E | `test/<contexto>/*.e2e-spec.ts` | HTTP, banco, constraints, integração |

Exemplo:

```
test/wallet/wallet.entity.spec.ts
test/wallet/wallet.constraints.e2e-spec.ts
test/wallet/wallet.migration.spec.ts
test/wallet/wallet.migration.e2e-spec.ts
```

## Regra obrigatória de documentação de testes

Sempre documentar quando houver uma atualização em teste.

Atualizar [`docs/TESTING.md`](../docs/TESTING.md) sempre que:

- criar, renomear ou remover arquivo de teste
- mudar o que um teste cobre
- adicionar/alterar script de teste no `package.json`
- mudar helpers, configs Jest ou forma de rodar os testes

Não considerar a tarefa concluída sem a doc alinhada.

### Checklist

- [ ] Teste unitário criado/atualizado
- [ ] Teste e2e criado/atualizado
- [ ] Ambos passando localmente
- [ ] `docs/TESTING.md` atualizado refletindo a mudança

### Comandos

Ver detalhes em [`docs/TESTING.md`](../docs/TESTING.md).

```bash
bun run test:unit -- <nome>
bun run test:e2e -- <nome>
bun run test:all
```

## Padrões do projeto

- Dinheiro/`balance`: sempre `string`, nunca `number`
- Schema do banco: só via migrations versionadas (`migration:create` / `run` / `revert`)
- E2E de banco: transação + `ROLLBACK` (`test/helpers/db.ts`)
- Constraints Postgres: assertar `code` + `constraint`
- Não mockar o que o e2e precisa provar de verdade (DB/HTTP)

## Anti-padrões

- Entregar feature só com unitário ou só com e2e
- Alterar schema no psql/`synchronize` fora de migration
- Colocar regra de negócio só no teste, sem implementação
- Mudar testes sem atualizar `docs/TESTING.md`
