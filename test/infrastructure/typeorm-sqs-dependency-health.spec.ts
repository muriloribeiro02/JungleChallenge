import { TypeOrmSqsDependencyHealth } from '../../src/infrastructure/health/typeorm-sqs-dependency-health';
import type { MessageBus } from '../../src/application/ports/message-bus';

describe('TypeOrmSqsDependencyHealth (unit)', () => {
  const dataSource = {
    query: jest.fn(),
  };
  const messageBus: MessageBus = {
    publish: jest.fn(),
    receive: jest.fn(),
    ack: jest.fn(),
  };
  let health: TypeOrmSqsDependencyHealth;

  beforeEach(() => {
    dataSource.query.mockReset();
    jest.mocked(messageBus.receive).mockReset();
    health = new TypeOrmSqsDependencyHealth(
      dataSource as never,
      messageBus,
    );
  });

  it('ambos ok', async () => {
    dataSource.query.mockResolvedValueOnce([{ ok: 1 }]);
    jest.mocked(messageBus.receive).mockResolvedValueOnce([]);
    await expect(health.check()).resolves.toEqual({
      postgres: true,
      sqs: true,
    });
  });

  it('Postgres falha', async () => {
    dataSource.query.mockRejectedValueOnce(new Error('pg'));
    jest.mocked(messageBus.receive).mockResolvedValueOnce([]);
    await expect(health.check()).resolves.toEqual({
      postgres: false,
      sqs: true,
    });
  });

  it('SQS falha', async () => {
    dataSource.query.mockResolvedValueOnce([{ ok: 1 }]);
    jest.mocked(messageBus.receive).mockRejectedValueOnce(new Error('sqs'));
    await expect(health.check()).resolves.toEqual({
      postgres: true,
      sqs: false,
    });
  });

  it('reutiliza o mesmo MessageBus (sem fromEnv)', async () => {
    dataSource.query.mockResolvedValue([{ ok: 1 }]);
    jest.mocked(messageBus.receive).mockResolvedValue([]);
    await health.check();
    await health.check();
    expect(messageBus.receive).toHaveBeenCalledTimes(2);
    expect(messageBus.receive).toHaveBeenCalledWith(1, 0);
  });
});
