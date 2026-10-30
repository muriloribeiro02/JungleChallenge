import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../../src/api/http/health/health.controller';
import type { DependencyHealthPort } from '../../src/application/ports/dependency-health';

describe('HealthController (unit)', () => {
  const dependencyHealth: jest.Mocked<DependencyHealthPort> = {
    check: jest.fn(),
  };
  const workers = {
    isStopping: false,
  };
  let controller: HealthController;

  beforeEach(() => {
    workers.isStopping = false;
    dependencyHealth.check.mockReset();
    dependencyHealth.check.mockResolvedValue({
      postgres: true,
      sqs: true,
    });
    controller = new HealthController(
      dependencyHealth,
      workers as never,
    );
  });

  describe('live', () => {
    it('retorna ok quando não está em shutdown', () => {
      const body = controller.live();
      expect(body.status).toBe('ok');
      expect(body.stopping).toBe(false);
    });

    it('retorna stopping sem lançar (liveness ≠ readiness)', () => {
      workers.isStopping = true;
      const body = controller.live();
      expect(body.status).toBe('stopping');
      expect(body.stopping).toBe(true);
    });
  });

  describe('ready', () => {
    it('PG + SQS ok → status ok', async () => {
      await expect(controller.ready()).resolves.toEqual({
        status: 'ok',
        postgres: true,
        sqs: true,
      });
    });

    it('PG indisponível → 503 NOT_READY', async () => {
      dependencyHealth.check.mockResolvedValueOnce({
        postgres: false,
        sqs: true,
      });
      try {
        await controller.ready();
        fail('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(
          (error as ServiceUnavailableException).getResponse(),
        ).toMatchObject({
          statusCode: 503,
          error: 'NOT_READY',
          postgres: false,
          sqs: true,
        });
      }
    });

    it('SQS indisponível → 503 NOT_READY', async () => {
      dependencyHealth.check.mockResolvedValueOnce({
        postgres: true,
        sqs: false,
      });
      try {
        await controller.ready();
        fail('expected throw');
      } catch (error) {
        expect(
          (error as ServiceUnavailableException).getResponse(),
        ).toMatchObject({
          statusCode: 503,
          error: 'NOT_READY',
          postgres: true,
          sqs: false,
        });
      }
    });

    it('shutdown → 503 SHUTTING_DOWN sem chamar a porta', async () => {
      workers.isStopping = true;
      try {
        await controller.ready();
        fail('expected throw');
      } catch (error) {
        expect(
          (error as ServiceUnavailableException).getResponse(),
        ).toMatchObject({
          statusCode: 503,
          error: 'SHUTTING_DOWN',
        });
      }
      expect(dependencyHealth.check).not.toHaveBeenCalled();
    });
  });
});
