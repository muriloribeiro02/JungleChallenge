import {
  OUTBOX_INTERVENTION_ATTEMPT_THRESHOLD,
  shouldRequireOutboxIntervention,
} from '../../src/domain/outbox/outbox-intervention.policy';
import { sanitizeOperationalError } from '../../src/application/messaging/sanitize-operational-error';

describe('Outbox intervention policy (unit)', () => {
  it('limiar é 10 tentativas (attempts do claim)', () => {
    expect(OUTBOX_INTERVENTION_ATTEMPT_THRESHOLD).toBe(10);
    expect(shouldRequireOutboxIntervention(9)).toBe(false);
    expect(shouldRequireOutboxIntervention(10)).toBe(true);
    expect(shouldRequireOutboxIntervention(11)).toBe(true);
  });

  it('sanitizeOperationalError redige segredos e trunca', () => {
    const raw =
      'publish failed password=supersecret token=abc123 postgresql://user:pass@host/db "amount":"99.50"';
    const sanitized = sanitizeOperationalError(raw, 80);
    expect(sanitized).not.toContain('supersecret');
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('user:pass');
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized.length).toBeLessThanOrEqual(81);
  });
});
