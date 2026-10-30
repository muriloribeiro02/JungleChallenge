import {
  computePendingNextAttemptAt,
  isPendingReferenceExpired,
  PENDING_REFERENCE_TTL_MS,
} from '../../src/domain/wager-transaction/pending-reference-policy';

describe('pending-reference-policy (unit)', () => {
  const now = new Date('2026-10-30T12:00:00.000Z');

  it('TTL é 24 horas', () => {
    expect(PENDING_REFERENCE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('isPendingReferenceExpired respeita exatamente 24h', () => {
    const at = new Date(now.getTime() - PENDING_REFERENCE_TTL_MS);
    expect(isPendingReferenceExpired(at, now)).toBe(true);
    expect(
      isPendingReferenceExpired(
        new Date(now.getTime() - PENDING_REFERENCE_TTL_MS + 1),
        now,
      ),
    ).toBe(false);
  });

  it('backoff = min(300, 2^n) segundos', () => {
    expect(computePendingNextAttemptAt(1, now).getTime()).toBe(
      now.getTime() + 2_000,
    );
    expect(computePendingNextAttemptAt(2, now).getTime()).toBe(
      now.getTime() + 4_000,
    );
    expect(computePendingNextAttemptAt(8, now).getTime()).toBe(
      now.getTime() + 256_000,
    );
    expect(computePendingNextAttemptAt(9, now).getTime()).toBe(
      now.getTime() + 300_000,
    );
    expect(computePendingNextAttemptAt(20, now).getTime()).toBe(
      now.getTime() + 300_000,
    );
  });
});
