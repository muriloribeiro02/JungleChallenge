import { IsString, Matches, Validate } from 'class-validator';
import { MoneyAmountMaxAbsConstraint } from './money-amount.max-abs.constraint';

/**
 * Money no contrato HTTP: amount sempre string decimal (nunca number).
 * Escala ≤2 (@Matches) + magnitude NUMERIC(19,2) (shared/money-limits).
 */
export class MoneyDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/, {
    message: 'amount deve ser decimal string com no máximo 2 casas',
  })
  @Validate(MoneyAmountMaxAbsConstraint)
  amount!: string;

  @IsString()
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'currency deve ser ISO-4217 (3 letras)',
  })
  currency!: string;
}
