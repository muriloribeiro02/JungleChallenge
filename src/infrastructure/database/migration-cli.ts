import dataSource from './data-source';

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || !['run', 'revert', 'show'].includes(command)) {
    console.error('Uso: migration-cli <run|revert|show>');
    process.exitCode = 1;
    return;
  }

  await dataSource.initialize();

  try {
    if (command === 'run') {
      const applied = await dataSource.runMigrations();
      if (applied.length === 0) {
        console.log('Nenhuma migration pendente.');
        return;
      }

      console.log(
        `Aplicada(s) ${applied.length} migration(s):`,
        applied.map((migration) => migration.name).join(', '),
      );
      return;
    }

    if (command === 'revert') {
      await dataSource.undoLastMigration();
      console.log('Última migration revertida.');
      return;
    }

    const hasPending = await dataSource.showMigrations();
    console.log(
      hasPending
        ? 'Há migrations pendentes.'
        : 'Banco sincronizado: todas as migrations estão aplicadas.',
    );
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
