import type { DataSource } from 'typeorm';
import type {
  DependencyHealthPort,
  DependencyHealthSnapshot,
} from '../../application/ports/dependency-health';
import type { MessageBus } from '../../application/ports/message-bus';

/**
 * Adapter: Postgres via DataSource; SQS via MessageBus.checkAvailable
 * (GetQueueAttributes — sem ReceiveMessage / side effects de visibility).
 */
export class TypeOrmSqsDependencyHealth implements DependencyHealthPort {
  constructor(
    private readonly dataSource: DataSource,
    private readonly messageBus: MessageBus,
  ) {}

  async check(): Promise<DependencyHealthSnapshot> {
    let postgres = false;
    let sqs = false;

    try {
      await this.dataSource.query('SELECT 1');
      postgres = true;
    } catch {
      postgres = false;
    }

    try {
      await this.messageBus.checkAvailable();
      sqs = true;
    } catch {
      sqs = false;
    }

    return { postgres, sqs };
  }
}
