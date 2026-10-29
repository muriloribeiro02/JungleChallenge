1 - Iniciei o projeto criando a tebela "wallet", com as colunas:
id (uuid gerado pela aplicação), 
player id(uuid do jogador), 
currency (qual a moeda (BRL, USD, EUR...)), 
balance(decimal exato, sem usar number no Ts para dinheiro), 
version(começa com 1 e muda após uma transação), 
created_at 
updated_at

2- Defini a regra de migrations que seriam todos manuais, para que seja possivel a criação das migrations e rollback caso necessario. Ajuda tambem quando outro dev for pegar o projeto, ele consegue rodar as migrations de acordo com o nome, o mesmo vai saber o que cada uma faz.

Para criar uma migration: bun run migration:create AddSomething
Para aplicar: bun run migration:run
Para dar Rollback: bun run migration:revert
Status: bun run migration:show

3 - Por que Wallet é um construtor privado? Utilizamos private constructor para impedir a criação direta por outras classes sem regras. Por exemplo, com um construtor privado, nós conseguimos definir que o valor de balance seja -100 e o version seja 0.

O que é o rehydrat? É um metodo utilizado para reconstruir a carteira a partir dos dados persistidos, ao invés de criar uma nova carteira. 