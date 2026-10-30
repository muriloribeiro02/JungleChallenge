1 - Iniciei o projeto criando a tabela "wallet", com as colunas:
id (uuid gerado pela aplicação), 
player id(uuid do jogador), 
currency (qual a moeda (BRL, USD, EUR...)), 
balance(decimal exato, sem usar number no Ts para dinheiro), 
version(começa com 1 e altera após as regras de atualizações da carteira), 
created_at 
updated_at

2- Defini a regra de migrations que seriam todos manuais, para que seja possivel a criação das migrations e rollback caso necessario. Ajuda tambem quando outro dev for pegar o projeto, ele consegue rodar as migrations de acordo com o nome, o mesmo vai saber o que cada uma faz.

Para criar uma migration: bun run migration:create AddSomething
Para aplicar: bun run migration:run
Para dar Rollback: bun run migration:revert
Status: bun run migration:show

3 - Por que Wallet é um construtor privado? Utilizamos private constructor para impedir a criação direta por outras classes sem regras. Por exemplo, com um construtor privado, nós conseguimos barrar que valores como o  de balance seja -100 e o version seja 0.

O que é o rehydrate? É um metodo utilizado para reconstruir a carteira a partir dos dados persistidos, ao invés de criar uma nova carteira. 

4 - Apliquei a ORM TypeORM, como intermediador das consultas. Eu vejo as ORMs como um intermediador, ele permite mapear as entidades e ajuda a executar consultas, sem necessariamente escrever SQL manualmente. (A escolha do typeORM: Me familiarizei melhor, não conheço ainda o MikroORM, porém ja estou estudando, e em breve estarei apto para atuar com esta ORM). O desafio aceita TypeORM, então foquei em fazer a engenharia certa em cima dele: transação, lock e migration — não em trocar de ORM no meio do caminho.

5 - Wallet-Ledger: É o historico financeiro que deve ser preservado, nele nós conseguimos ver o valor creditado, debitado, saldo antes e depois da movimentação. Sem ledger não tem como provar de onde veio o saldo. Por isso o lançamento é imutável: se errou, não edita a linha — a história fica lá.

6 - Money: dinheiro nunca entra como number no TypeScript. Usei decimal.js pra somar/subtrair com escala fixa de 2 casas. Number em JS é float e financeiro com float é pedrada na roda. No banco ficou NUMERIC(19,2). Tem um detalhe chato do Postgres: ele arredonda se você enfiar mais de 2 casas — então a rejeição de verdade fica na aplicação (Money / MoneyDto). O bigint aparece só pra checar o teto de magnitude, não pra fazer a conta do dia a dia.

7 - Camadas: separei domain / application / infrastructure / api. Nest fica na borda (controller, DTO, guard). Domínio não importa Nest. Use case fala com porta (UnitOfWork, MessageBus, Metrics), e a infra implementa. Isso parece “mais arquivo”, mas quando você precisa testar BET sem subir SQS, faz sentido.

8 - Unit of Work: tudo que é efeito financeiro (wallet + ledger + wager_transaction + outbox, e inbox quando a entrada é fila) entra na mesma transação SQL. TypeOrmUnitOfWork só abre DataSource.transaction e entrega os repos no mesmo EntityManager. Ou grava tudo, ou não grava nada. Publicar no SQS dentro da TX financeira eu não faço — isso é trabalho do outbox depois do commit.

9 - Concorrência na wallet: fui de SELECT FOR UPDATE (lock pessimista). Duas BET batendo no mesmo saldo ao mesmo tempo não podem as duas debitar. A segunda espera a primeira soltar a linha, lê o saldo novo e rejeita se não couber. Sobre o version: ele sobe quando o saldo muda e aparece em API/evento/snapshot, mas ele NÃO é optimistic locking. Não tem UPDATE … WHERE version = X. Quem segura a concorrência é o FOR UPDATE.

10 - WagerTransaction: BET / WIN / LOSS / REFUND / ROLLBACK. LOSS não mexe saldo nem gera ledger. REFUND e ROLLBACK precisam de referência; se a referência ainda não chegou, fica PENDING_REFERENCE e um worker reprocessa com backoff. Depois de 24h sem referência, vira REJECTED com REFERENCE_NOT_FOUND. Também fechei a porta de REFUND + ROLLBACK na mesma BET (os dois creditariam): no máximo uma reversão PROCESSED por referência.

11 - Idempotência: header Idempotency-Key é a verdade. Guardo um payload_hash (JSON canônico com chaves ordenadas + SHA-256 dos campos de negócio). Mesma key + mesmo hash = replay. Mesma key + hash diferente = conflito 409. Não dá pra confiar em cache em memória pra isso — tem que ser no banco.

12 - Outbox: gravo o evento na mesma TX do efeito. Um publisher puxa com FOR UPDATE SKIP LOCKED + lease (locked_until), manda pro SQS e marca published. Se a máquina morrer no meio, outra instância pega de novo. Inbox do outro lado deduplica por (consumer_name, message_id), porque a entrega é at-least-once — a gente não promete exactly-once ponta a ponta.

13 - Intervenção do Outbox: attempts sobe no claim (pode contar crash abandonado, não só falha de publish). Backoff exponencial até 300s. A partir de 10 tentativas eu pauso o evento (intervention_required_at) em vez de ficar retry infinito no escuro. Não apago evento e não marco published na falha. Pra liberar de novo: CLI ops (bun run ops:clear-outbox-intervention), sem endpoint HTTP público de admin.

14 - Filas: inbound de aposta é FIFO (contrato), com MessageGroupId ligado à wallet na prática. Fila de eventos do outbox ficou standard no ambiente local — o consumer ainda depende do Inbox, não da ordenação mágica do broker. Broker ajuda; banco garante.

15 - Shutdown: SIGTERM drena o que está em voo. Se estourou o tempo, não dá ACK e devolve visibilidade. Outbox claimada recupera pelo lease. Ready passa a 503 enquanto está parando.

16 - Auth: não implementei IdP (o desafio deixa e não vale ponto). Tem NoopAuthGuard + ProviderIdentityPort como ponto de extensão. No futuro o providerId confiável viria do token (Keycloak/Zitadel), não do body “porque o cliente mandou”.

17 - Métricas: Prometheus por instância (/metrics), sem colocar eventId/walletId como label. Tem gauge de outbox pendente, intervenção, lag, DLQ aproximada, etc. Detalhe no docs/METRICS.md.

18 - Testes: unitário + e2e de verdade (Postgres/LocalStack). Multi-instância sobe app-1/2/3. Detalhe importante de engenharia local: antes de test:messaging, sobe apps:down — senão os containers roubam mensagem da fila e o teste flaka.

O desenho mais formal (ADR, trade-offs, evidência de arquivo) está no ARCHITECTURE.md. Este arquivo é o “como eu fui pensando a engenharia” no caminho.
