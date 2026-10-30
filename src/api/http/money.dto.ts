import { IsString, Matches } from 'class-validator';

/**
 * Money no contrato HTTP: amount sempre string decimal (nunca number).
 */
export class MoneyDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/, {
    message: 'amount deve ser decimal string com no máximo 2 casas',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'currency deve ser ISO-4217 (3 letras)',
  })
  currency!: string;
}
