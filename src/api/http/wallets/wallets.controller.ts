import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { GetWalletUseCase } from '../../../application/use-cases/wallet/get-wallet.use-case';
import { ListWalletLedgerUseCase } from '../../../application/use-cases/wallet/list-wallet-ledger.use-case';
import { OpenWalletUseCase } from '../../../application/use-cases/wallet/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../../application/use-cases/wallet/reconcile-wallet.use-case';
import { NoopAuthGuard } from '../../auth/noop-auth.guard';
import { CreateWalletDto } from './create-wallet.dto';

@UseGuards(NoopAuthGuard)
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListWalletLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateWalletDto) {
    const result = await this.openWallet.execute({
      playerId: body.playerId,
      currency: body.initialBalance.currency,
      initialBalance: body.initialBalance.amount,
    });

    return {
      id: result.id,
      playerId: result.playerId,
      balance: {
        amount: result.balance,
        currency: result.currency,
      },
      version: result.version,
    };
  }

  @Get(':walletId')
  async getOne(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.getWallet.execute({ walletId });
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : 50;
    return this.listLedger.execute({
      walletId,
      cursor,
      limit: Number.isFinite(limit) ? limit : 50,
    });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconciliation(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.reconcile.execute({ walletId });
  }
}
