import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type {
  BusMessage,
  MessageBus,
  ReceivedBusMessage,
} from '../../application/messaging/message-bus';
import { sqsEnv } from './sqs.env';

export class SqsMessageBus implements MessageBus {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string = sqsEnv.mainQueueUrl,
  ) {}

  static fromEnv(queueUrl: string = sqsEnv.mainQueueUrl): SqsMessageBus {
    return new SqsMessageBus(
      new SQSClient({
        region: sqsEnv.region,
        endpoint: sqsEnv.endpoint,
        credentials: {
          accessKeyId: sqsEnv.accessKeyId,
          secretAccessKey: sqsEnv.secretAccessKey,
        },
      }),
      queueUrl,
    );
  }

  async publish(message: BusMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: message.body,
        MessageAttributes: {
          eventId: {
            DataType: 'String',
            StringValue: message.id,
          },
          ...(message.attributes
            ? Object.fromEntries(
                Object.entries(message.attributes).map(([key, value]) => [
                  key,
                  { DataType: 'String', StringValue: value },
                ]),
              )
            : {}),
        },
      }),
    );
  }

  async receive(
    maxMessages: number,
    waitTimeSeconds: number,
  ): Promise<ReceivedBusMessage[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.min(10, Math.max(1, maxMessages)),
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: sqsEnv.visibilityTimeoutSeconds,
        MessageAttributeNames: ['All'],
        AttributeNames: ['All'],
      }),
    );

    return (result.Messages ?? []).map((msg) => {
      const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? 1);
      const eventIdAttr = msg.MessageAttributes?.eventId?.StringValue;
      return {
        id: eventIdAttr ?? msg.MessageId ?? '',
        body: msg.Body ?? '',
        receiptHandle: msg.ReceiptHandle ?? '',
        transportMessageId: msg.MessageId ?? '',
        receiveCount,
      };
    });
  }

  async ack(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}
