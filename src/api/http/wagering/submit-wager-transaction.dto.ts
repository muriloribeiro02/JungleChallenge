import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MoneyDto } from '../money.dto';

export class SubmitWagerTransactionDto {
  @IsString()
  @MinLength(1)
  providerId!: string;

  @IsString()
  @MinLength(1)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @MinLength(1)
  roundId!: string;

  @IsString()
  @MinLength(1)
  gameId!: string;

  @IsIn(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])
  kind!: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @MinLength(1)
  referenceExternalTransactionId?: string;
}
