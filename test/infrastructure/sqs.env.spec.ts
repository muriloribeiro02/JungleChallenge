import { loadSqsEnv } from '../../src/infrastructure/messaging/sqs.env';

describe('loadSqsEnv', () => {
  it('aplica defaults do código quando vars numéricas estão ausentes', () => {
    const env = loadSqsEnv({});
    expect(env.visibilityTimeoutSeconds).toBe(30);
    expect(env.maxReceiveCount).toBe(5);
    expect(env.publisherBatchSize).toBe(10);
    expect(env.claimLeaseSeconds).toBe(60);
    expect(env.receiveWaitSeconds).toBe(1);
    expect(env.receiveMaxMessages).toBe(10);
  });

  it('aceita overrides válidos', () => {
    const env = loadSqsEnv({
      SQS_VISIBILITY_TIMEOUT_SECONDS: '0',
      SQS_MAX_RECEIVE_COUNT: '3',
      OUTBOX_PUBLISHER_BATCH_SIZE: '2',
      OUTBOX_CLAIM_LEASE_SECONDS: '15',
      SQS_RECEIVE_WAIT_SECONDS: '20',
      SQS_RECEIVE_MAX_MESSAGES: '1',
    });
    expect(env.visibilityTimeoutSeconds).toBe(0);
    expect(env.maxReceiveCount).toBe(3);
    expect(env.publisherBatchSize).toBe(2);
    expect(env.claimLeaseSeconds).toBe(15);
    expect(env.receiveWaitSeconds).toBe(20);
    expect(env.receiveMaxMessages).toBe(1);
  });

  it('rejeita WaitTimeSeconds fora de 0–20 sem fallback', () => {
    expect(() =>
      loadSqsEnv({ SQS_RECEIVE_WAIT_SECONDS: '21' }),
    ).toThrow(/SQS_RECEIVE_WAIT_SECONDS/);
  });

  it('rejeita MaxNumberOfMessages fora de 1–10', () => {
    expect(() =>
      loadSqsEnv({ SQS_RECEIVE_MAX_MESSAGES: '0' }),
    ).toThrow(/SQS_RECEIVE_MAX_MESSAGES/);
    expect(() =>
      loadSqsEnv({ SQS_RECEIVE_MAX_MESSAGES: '11' }),
    ).toThrow(/SQS_RECEIVE_MAX_MESSAGES/);
  });

  it('rejeita maxReceiveCount / batch / lease inválidos', () => {
    expect(() => loadSqsEnv({ SQS_MAX_RECEIVE_COUNT: '0' })).toThrow(
      /SQS_MAX_RECEIVE_COUNT/,
    );
    expect(() => loadSqsEnv({ OUTBOX_PUBLISHER_BATCH_SIZE: 'x' })).toThrow(
      /OUTBOX_PUBLISHER_BATCH_SIZE/,
    );
    expect(() => loadSqsEnv({ OUTBOX_CLAIM_LEASE_SECONDS: '-5' })).toThrow(
      /OUTBOX_CLAIM_LEASE_SECONDS/,
    );
  });
});
