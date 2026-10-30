import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import {
  isMoneyAmountWithinMaxAbs,
  MONEY_MAX_ABS_AMOUNT,
} from '../../shared/money-limits';

/**
 * Magnitude NUMERIC(19,2). Formato/escala ficam em @Matches no MoneyDto.
 */
@ValidatorConstraint({ name: 'moneyAmountMaxAbs', async: false })
export class MoneyAmountMaxAbsConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    if (typeof value !== 'string') {
      return false;
    }
    return isMoneyAmountWithinMaxAbs(value);
  }

  defaultMessage(_args: ValidationArguments): string {
    return `amount não pode exceder ${MONEY_MAX_ABS_AMOUNT}`;
  }
}
