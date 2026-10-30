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
    checkAvailable: jest.fn(),
  };
  let health: TypeOrmSqsDependencyHealth;

  beforeEach(() => {
    dataSource.query.mockReset();
    jest.mocked(messageBus.receive).mockReset();
    jest.mocked(messageBus.checkAvailable).mockReset();
    health = new TypeOrmSqsDependencyHealth(
      dataSource as never,
      messageBus,
    );
  });

  it('ambos ok — usa checkAvailable, não receive', async () => {
    dataSource.query.mockResolvedValueOnce([{ ok: 1 }]);
    jest.mocked(messageBus.checkAvailable).mockResolvedValueOnce(undefined);
    await expect(health.check()).resolves.toEqual({
      postgres: true,
      sqs: true,
    });
    expect(messageBus.checkAvailable).toHaveBeenCalledTimes(1);
    expect(messageBus.receive).not.toHaveBeenCalled();
  });

  it('Postgres falha', async () => {
    dataSource.query.mockRejectedValueOnce(new Error('pg'));
    jest.mocked(messageBus.checkAvailable).mockResolvedValueOnce(undefined);
    await expect(health.check()).resolves.toEqual({
      postgres: false,
      sqs: true,
    });
    expect(messageBus.receive).not.toHaveBeenCalled();
  });

  it('SQS indisponível (checkAvailable rejeita)', async () => {
    dataSource.query.mockResolvedValueOnce([{ ok: 1 }]);
    jest
      .mocked(messageBus.checkAvailable)
      .mockRejectedValueOnce(new Error('sqs'));
    await expect(health.check()).resolves.toEqual({
      postgres: true,
      sqs: false,
    });
    expect(messageBus.receive).not.toHaveBeenCalled();
  });

  it('Falha de GetQueueAttributes (via checkAvailable) → sqs=false', async () => {
    dataSource.query.mockResolvedValueOnce([{ ok: 1 }]);
    jest
      .mocked(messageBus.checkAvailable)
      .mockRejectedValueOnce(new Error('GetQueueAttributes failed'));
    await expect(health.check()).resolves.toEqual({
      postgres: true,
      sqs: false,
    });
    expect(messageBus.receive).not.toHaveBeenCalled();
  });

  it('reutiliza o mesmo MessageBus (sem fromEnv)', async () => {
    dataSource.query.mockResolvedValue([{ ok: 1 }]);
    jest.mocked(messageBus.checkAvailable).mockResolvedValue(undefined);
    await health.check();
    await health.check();
    expect(messageBus.checkAvailable).toHaveBeenCalledTimes(2);
    expect(messageBus.receive).not.toHaveBeenCalled();
  });
});
