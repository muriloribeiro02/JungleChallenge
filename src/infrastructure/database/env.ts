import { config } from 'dotenv';

config({ quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Variável de ambiente obrigatória ausente: ${name}. Copie .env.example para .env e preencha os valores.`,
    );
  }
  return value;
}

export const databaseEnv = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5434', 10),
  username: process.env.DATABASE_USER ?? 'jungle',
  password: required('DATABASE_PASSWORD'),
  database: process.env.DATABASE_NAME ?? 'jungle_db',
};
