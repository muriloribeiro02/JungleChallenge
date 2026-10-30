import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DEPENDENCY_HEALTH,
  type DependencyHealthPort,
} from '../../../application/ports/dependency-health';
import { MessagingWorkersHost } from '../../../infrastructure/messaging/messaging-workers.host';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DEPENDENCY_HEALTH)
    private readonly dependencyHealth: DependencyHealthPort,
    private readonly workers: MessagingWorkersHost,
  ) {}

  @Get('live')
  live(): {
    status: 'ok' | 'stopping';
    instanceId: string;
    pid: number;
    workersEnabled: boolean;
    stopping: boolean;
  } {
    const stopping = this.workers.isStopping;
    return {
      status: stopping ? 'stopping' : 'ok',
      instanceId: process.env.INSTANCE_ID ?? `pid-${process.pid}`,
      pid: process.pid,
      workersEnabled:
        (process.env.WORKERS_ENABLED ?? 'false').toLowerCase() === 'true',
      stopping,
    };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; postgres: boolean; sqs: boolean }> {
    if (this.workers.isStopping) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'SHUTTING_DOWN',
        message: 'Instância em graceful shutdown',
      });
    }

    const { postgres, sqs } = await this.dependencyHealth.check();

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
