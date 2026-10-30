import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  APP_COMPOSITION,
  type AppCompositionToken,
} from '../../../composition/tokens';

/**
 * Exposition Prometheus — independente dos endpoints financeiros.
 * Sem auth no ambiente local (NoopAuthGuard).
 */
@Controller()
export class MetricsController {
  constructor(
    @Inject(APP_COMPOSITION) private readonly app: AppCompositionToken,
  ) {}

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async metrics(@Res() res: Response): Promise<void> {
    const exposition = this.app.metricsExposition;
    const body = await exposition.collect();
    res.setHeader('Content-Type', exposition.contentType());
    res.status(200).send(body);
  }
}
