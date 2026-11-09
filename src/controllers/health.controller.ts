import type { Request, Response } from 'express';
import type { Metrics } from '../observability/metrics';
import type { HealthService } from '../services/health.service';

export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly metrics: Metrics,
  ) {}

  /** GET /healthz - liveness: the process is up and the event loop is responsive. */
  liveness = (_req: Request, res: Response): void => {
    res.status(200).json({ status: 'ok' });
  };

  /** GET /readyz - readiness: safe to route traffic here (DB reachable, accepting writes). */
  readiness = async (_req: Request, res: Response): Promise<void> => {
    const report = await this.healthService.readiness();
    res.status(report.ready ? 200 : 503).json({
      status: report.ready ? 'ready' : 'not_ready',
      checks: {
        database: report.checks.database,
        write_queue: report.checks.writeQueue,
        shutting_down: report.checks.shuttingDown,
      },
    });
  };

  /** GET /metrics - Prometheus exposition format. */
  prometheus = async (_req: Request, res: Response): Promise<void> => {
    res.setHeader('Content-Type', this.metrics.contentType());
    res.status(200).send(await this.metrics.render());
  };
}
