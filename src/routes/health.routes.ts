import { Router } from 'express';
import type { HealthController } from '../controllers/health.controller';

export function healthRoutes(controller: HealthController): Router {
  const router = Router();
  router.get('/healthz', controller.liveness);
  router.get('/readyz', controller.readiness);
  router.get('/metrics', controller.prometheus);
  return router;
}
