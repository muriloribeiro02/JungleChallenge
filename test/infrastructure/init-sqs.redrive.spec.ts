import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqsEnv } from '../../src/infrastructure/messaging/sqs.env';

/**
 * Contratos estáticos do init LocalStack (sem side effect em filas).
 * Comportamento runtime: ver `init-sqs-redrive.e2e-spec.ts`.
 */
describe('init-sqs.sh redrive (unit / contrato do script)', () => {
  const script = readFileSync(
    join(__dirname, '../../docker/localstack/init-sqs.sh'),
    'utf8',
  );

  it('usa SQS_MAX_RECEIVE_COUNT com default 5', () => {
    expect(script).toMatch(/MAX_RECEIVE_COUNT="\$\{SQS_MAX_RECEIVE_COUNT:-5\}"/);
  });

  it('aplica RedrivePolicy via set-queue-attributes (não só no create)', () => {
    expect(script).toMatch(/set-queue-attributes/);
    expect(script).toMatch(/apply_main_redrive/);
    expect(script).toMatch(/maxReceiveCount/);
  });

  it('não hardcoda maxReceiveCount literal 5 na RedrivePolicy', () => {
    expect(script.includes('maxReceiveCount\\":\\"5\\"')).toBe(false);
    expect(script.includes('maxReceiveCount\\\":\\\"5\\\"')).toBe(false);
    expect(script).toContain('${MAX_RECEIVE_COUNT}');
  });

  it('aplica redrive só nas filas principais (função dedicada + 2 chamadas)', () => {
    const applies = script.match(/apply_main_redrive "/g) ?? [];
    expect(applies.length).toBe(2);
    expect(script).toContain('apply_main_redrive "$EVENTS_URL"');
    expect(script).toContain('apply_main_redrive "$INBOUND_URL"');
  });

  it('sqsEnv compartilha a mesma fonte (default 5)', () => {
    expect(Number.isFinite(sqsEnv.maxReceiveCount)).toBe(true);
    expect(sqsEnv.maxReceiveCount).toBeGreaterThanOrEqual(1);
    // Sem override no processo de teste unitário, default do código é 5
    if (process.env.SQS_MAX_RECEIVE_COUNT === undefined) {
      expect(sqsEnv.maxReceiveCount).toBe(5);
    }
  });
});
