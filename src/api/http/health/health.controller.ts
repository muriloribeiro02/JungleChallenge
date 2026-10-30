import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
  APP_COMPOSITION,
  type AppCompositionToken,
} from '../../../composition/tokens';
import { SqsMessageBus } from '../../../infrastructure/messaging/sqs-message-bus';
import { sqsEnv } from '../../../infrastructure/messaging/sqs.env';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_COMPOSITION) private readonly app: AppCompositionToken,
  ) {}

  @Get('live')
  live(): {
    status: 'ok';
    instanceId: string;
    pid: number;
    workersEnabled: boolean;
  } {
    return {
      status: 'ok',
      instanceId: process.env.INSTANCE_ID ?? `pid-${process.pid}`,
      pid: process.pid,
      workersEnabled:
        (process.env.WORKERS_ENABLED ?? 'false').toLowerCase() === 'true',
    };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; postgres: boolean; sqs: boolean }> {
    const dataSource = this.app.dataSource as DataSource;
    let postgres = false;
    let sqs = false;

    try {
      await dataSource.query('SELECT 1');
      postgres = true;
    } catch {
      postgres = false;
    }

    try {
      const bus = SqsMessageBus.fromEnv(sqsEnv.mainQueueUrl);
      await bus.receive(1, 0);
      sqs = true;
    } catch {
      sqs = false;
    }

    if (!postgres || !sqs) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'NOT_READY',
        message: 'Dependências indisponíveis',
        postgres,
        sqs,
      });
    }

    return { status: 'ok', postgres, sqs };
  }
}
