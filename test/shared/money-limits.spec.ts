import {
  isMoneyAmountWithinMaxAbs,
  MONEY_MAX_ABS_AMOUNT,
} from '../../src/shared/money-limits';

describe('money-limits (shared)', () => {
  it('aceita valor no limite e abaixo', () => {
    expect(isMoneyAmountWithinMaxAbs(MONEY_MAX_ABS_AMOUNT)).toBe(true);
    expect(isMoneyAmountWithinMaxAbs('99999999999999999.98')).toBe(true);
    expect(isMoneyAmountWithinMaxAbs('0.01')).toBe(true);
    expect(isMoneyAmountWithinMaxAbs('10.5')).toBe(true);
  });

  it('rejeita acima do limite', () => {
    expect(isMoneyAmountWithinMaxAbs('100000000000000000.00')).toBe(false);
    expect(isMoneyAmountWithinMaxAbs('999999999999999999.99')).toBe(false);
  });
});
