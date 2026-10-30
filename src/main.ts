import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Propaga SIGTERM/SIGINT → beforeApplicationShutdown → onModuleDestroy.
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(
    `listening port=${port} instance=${process.env.INSTANCE_ID ?? `pid-${process.pid}`}`,
  );
}

void bootstrap();
