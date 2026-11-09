import { Router } from 'express';
import type { MatchController } from '../controllers/match.controller';

export function matchRoutes(controller: MatchController): Router {
  const router = Router();
  router.post('/', controller.submit);
  return router;
}
