import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];

if (!name || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
  console.error(
    'Uso: bun run migration:create <NomeEmPascalCase>\nEx.: bun run migration:create CreateWalletTable',
  );
  process.exit(1);
}

const timestamp = Date.now();
const className = `${name}${timestamp}`;
const fileName = `${timestamp}-${name}.ts`;
const migrationsDir = join(__dirname, 'migrations');

if (!existsSync(migrationsDir)) {
  mkdirSync(migrationsDir, { recursive: true });
}

const content = `import { MigrationInterface, QueryRunner } from 'typeorm';

export class ${className} implements MigrationInterface {
  name = '${className}';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // TODO: aplicar alteração
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // TODO: reverter alteração
  }
}
`;

const filePath = join(migrationsDir, fileName);
writeFileSync(filePath, content, 'utf8');
console.log(`Migration criada: ${filePath}`);
