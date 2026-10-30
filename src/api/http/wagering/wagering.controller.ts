import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { GetWagerTransactionUseCase } from '../../../application/use-cases/wager/get-wager-transaction.use-case';
import { SubmitWagerTransactionUseCase } from '../../../application/use-cases/wager/submit-wager-transaction.use-case';
import { NoopAuthGuard } from '../../auth/noop-auth.guard';
import { SubmitWagerTransactionDto } from './submit-wager-transaction.dto';

@UseGuards(NoopAuthGuard)
@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Body() body: SubmitWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Header Idempotency-Key é obrigatório',
      });
    }

    const result = await this.submit.execute({
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      idempotencyKey: idempotencyKey.trim(),
    });

    res.status(
      result.status === 'PENDING_REFERENCE'
        ? HttpStatus.ACCEPTED
        : HttpStatus.OK,
    );

    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  @HttpCode(HttpStatus.OK)
  async byId(@Param('transactionId', ParseUUIDPipe) transactionId: string) {
    return this.getTransaction.byId({ transactionId });
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @HttpCode(HttpStatus.OK)
  async byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.getTransaction.byProviderExternal({
      providerId,
      externalTransactionId,
    });
  }
}
