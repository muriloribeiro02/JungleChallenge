import dataSource from '../database/data-source';
import { createAppComposition } from '../../composition/create-app-composition';
import { ClearOutboxInterventionUseCase } from '../../application/use-cases/outbox/clear-outbox-intervention.use-case';

/**
 * CLI operacional — limpa intervenção de um evento Outbox.
 * Uso: bun run ops:clear-outbox-intervention -- <eventId>
 *
 * Sem endpoint HTTP público.
 */
async function main(): Promise<void> {
  const eventId = process.argv[2];
  if (!eventId || !/^[0-9a-f-]{36}$/i.test(eventId)) {
    console.error('Uso: ops:clear-outbox-intervention <eventId-uuid>');
    process.exitCode = 1;
    return;
  }

  await dataSource.initialize();
  try {
    const composition = createAppComposition(dataSource);
    const useCase = new ClearOutboxInterventionUseCase(
      composition.unitOfWork,
      composition.logger,
    );
    const result = await useCase.execute({ eventId });
    console.log(
      JSON.stringify({
        ok: true,
        ...result,
      }),
    );
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
