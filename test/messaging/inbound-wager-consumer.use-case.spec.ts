import { randomUUID } from 'node:crypto';
import {
  InboundWagerConsumer,
  parseRequestedEnvelope,
} from '../../src/application/messaging/inbound-wager-consumer';
import type {
  MessageBus,
  ReceivedBusMessage,
} from '../../src/application/ports/message-bus';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import type { SubmitWagerTransactionUseCase } from '../../src/application/use-cases/wager/submit-wager-transaction.use-case';
import { INBOX_CONSUMER_WAGER_INBOUND } from '../../src/domain/inbox/inbox-message.entity';
import { FakeInboxRepository } from '../helpers/fake-inbox';

class FakeBus implements MessageBus {
  messages: ReceivedBusMessage[] = [];
  acked: string[] = [];
  visibility: Array<{ receiptHandle: string; seconds: number }> = [];

  async publish(): Promise<void> {}
  async receive(): Promise<ReceivedBusMessage[]> {
    return this.messages.splice(0, this.messages.length);
  }
  async ack(receiptHandle: string): Promise<void> {
    this.acked.push(receiptHandle);
  }
  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    this.visibility.push({ receiptHandle, seconds });
  }
  async checkAvailable(): Promise<void> {}
}

describe('InboundWagerConsumer (unit)', () => {
  function envelope(overrides: Record<string, unknown> = {}) {
    const dataOverride =
      typeof overrides.data === 'object' && overrides.data !== null
        ? (overrides.data as Record<string, unknown>)
        : {};
    const { data: _ignored, ...restOverrides } = overrides;
    return {
      messageId: 'msg-123',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      ...restOverrides,
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'tx-1',
        idempotencyKey: 'provider-a:tx-1',
        playerId: randomUUID(),
        walletId: randomUUID(),
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        ...dataOverride,
      },
    };
  }

  it('parseRequestedEnvelope aceita envelope válido', () => {
    const parsed = parseRequestedEnvelope(JSON.stringify(envelope()));
    expect(parsed.type).toBe('WagerTransactionRequested');
    expect(parsed.messageId).toBe('msg-123');
  });

  it('parse rejeita type inválido', () => {
    expect(() =>
      parseRequestedEnvelope(JSON.stringify(envelope({ type: 'Other' }))),
    ).toThrow(/type=/);
  });

  it('processa mensagem válida via Submit na mesma UoW e faz ACK', async () => {
    const bus = new FakeBus();
    const inbox = new FakeInboxRepository();
    const submitCalls: unknown[] = [];
    const submit = {
      executeWithRepos: jest.fn(async (_repos, input) => {
        submitCalls.push(input);
        return {
          transactionId: randomUUID(),
          status: 'PROCESSED',
          balance: { amount: '75.00', currency: 'BRL' },
          idempotentReplay: false,
        };
      }),
    } as unknown as SubmitWagerTransactionUseCase;

    const uow: UnitOfWork = {
      run: async (work) =>
        work({
          inboxMessages: inbox,
        } as unknown as TransactionalRepositories),
    };

    const consumer = new InboundWagerConsumer(
      bus,
      uow,
      submit,
      {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      },
      { maxMessages: 10, waitSeconds: 0 },
    );

    const body = JSON.stringify(envelope());
    bus.messages.push({
      id: 'msg-123',
      body,
      receiptHandle: 'rh-1',
      transportMessageId: 'sqs-1',
      receiveCount: 1,
    });

    const result = await consumer.pollOnce();
    expect(result.processed).toBe(1);
    expect(bus.acked).toEqual(['rh-1']);
    expect(submit.executeWithRepos).toHaveBeenCalledTimes(1);
    expect(inbox.items[0].consumerName).toBe(INBOX_CONSUMER_WAGER_INBOUND);
    expect(inbox.items[0].id).toBe('msg-123');
  });

  it('duplicata: ACK sem reexecutar Submit', async () => {
    const bus = new FakeBus();
    const inbox = new FakeInboxRepository();
    const submit = {
      executeWithRepos: jest.fn(),
    } as unknown as SubmitWagerTransactionUseCase;

    const uow: UnitOfWork = {
      run: async (work) =>
        work({
          inboxMessages: inbox,
        } as unknown as TransactionalRepositories),
    };

    const consumer = new InboundWagerConsumer(
      bus,
      uow,
      submit,
      { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      { maxMessages: 10, waitSeconds: 0 },
    );

    const body = JSON.stringify(envelope());
    const msg = {
      id: 'msg-123',
      body,
      receiptHandle: 'rh-1',
      transportMessageId: 'sqs-1',
      receiveCount: 1,
    };
    bus.messages.push({ ...msg });
    await consumer.pollOnce();
    bus.messages.push({ ...msg, receiptHandle: 'rh-2', receiveCount: 2 });
    const second = await consumer.pollOnce();

    expect(second.duplicates).toBe(1);
    expect(submit.executeWithRepos).toHaveBeenCalledTimes(1);
    expect(bus.acked).toContain('rh-2');
  });

  it('payload inválido (money number) falha sem ACK e zera visibility', async () => {
    const bus = new FakeBus();
    const uow: UnitOfWork = {
      run: async <T>(
        _work: (repos: TransactionalRepositories) => Promise<T>,
      ): Promise<T> => {
        throw new Error('UoW não deve ser chamado para money inválido');
      },
    };
    const consumer = new InboundWagerConsumer(
      bus,
      uow,
      { executeWithRepos: jest.fn() } as unknown as SubmitWagerTransactionUseCase,
      { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      { maxMessages: 10, waitSeconds: 0 },
    );

    bus.messages.push({
      id: 'bad',
      body: JSON.stringify(
        envelope({
          data: { money: { amount: 10 as unknown as string, currency: 'BRL' } },
        }),
      ),
      receiptHandle: 'rh-bad',
      transportMessageId: 'sqs-bad',
      receiveCount: 1,
    });

    const result = await consumer.pollOnce();
    expect(result.failed).toBe(1);
    expect(bus.acked).toHaveLength(0);
    expect(bus.visibility).toEqual([{ receiptHandle: 'rh-bad', seconds: 0 }]);
  });
});
