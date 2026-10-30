import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SqsMessageBus } from '../../src/infrastructure/messaging/sqs-message-bus';

describe('SqsMessageBus.checkAvailable (unit)', () => {
  const queueUrl = 'http://localhost:4566/000000000000/jungle-wager-events';

  it('resolve quando QueueArn está presente', async () => {
    const send = jest.fn().mockResolvedValue({
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:000000000000:jungle-wager-events' },
    });
    const bus = new SqsMessageBus({ send } as never, queueUrl);

    await expect(bus.checkAvailable()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(GetQueueAttributesCommand);
    expect(cmd.input).toMatchObject({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    });
  });

  it('rejeita quando QueueArn está ausente', async () => {
    const send = jest.fn().mockResolvedValue({ Attributes: {} });
    const bus = new SqsMessageBus({ send } as never, queueUrl);
    await expect(bus.checkAvailable()).rejects.toThrow(/QueueArn ausente/);
  });

  it('propaga erro do SDK (fila inacessível)', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(new Error('NetworkingError: connect ECONNREFUSED'));
    const bus = new SqsMessageBus({ send } as never, queueUrl);
    await expect(bus.checkAvailable()).rejects.toThrow(/ECONNREFUSED/);
  });
});
