import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MoneyDto } from '../../src/api/http/money.dto';
import { MONEY_MAX_ABS_AMOUNT } from '../../src/shared/money-limits';

async function validateMoney(partial: {
  amount?: unknown;
  currency?: unknown;
}) {
  const dto = plainToInstance(MoneyDto, partial);
  return validate(dto);
}

describe('MoneyDto', () => {
  it('aceita valor válido próximo ao limite', async () => {
    const errors = await validateMoney({
      amount: '99999999999999999.98',
      currency: 'BRL',
    });
    expect(errors).toHaveLength(0);
  });

  it('aceita valor exatamente no limite', async () => {
    const errors = await validateMoney({
      amount: MONEY_MAX_ABS_AMOUNT,
      currency: 'BRL',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejeita valor acima do limite', async () => {
    const errors = await validateMoney({
      amount: '100000000000000000.00',
      currency: 'BRL',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toMatch(/não pode exceder|maxAbs|amount/i);
  });

  it('rejeita escala superior a duas casas', async () => {
    const errors = await validateMoney({
      amount: '1.234',
      currency: 'BRL',
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejeita amount number e notação científica', async () => {
    expect(
      (await validateMoney({ amount: 10.5, currency: 'BRL' })).length,
    ).toBeGreaterThan(0);
    expect(
      (await validateMoney({ amount: '1e3', currency: 'BRL' })).length,
    ).toBeGreaterThan(0);
  });

  it('aceita uma e duas casas', async () => {
    expect(
      await validateMoney({ amount: '10.5', currency: 'usd' }),
    ).toHaveLength(0);
    expect(
      await validateMoney({ amount: '19.99', currency: 'BRL' }),
    ).toHaveLength(0);
  });
});
