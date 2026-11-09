import { Router } from 'express';
import type { PlayerStatsController } from '../controllers/player-stats.controller';

export function playerStatsRoutes(controller: PlayerStatsController): Router {
  const router = Router();
  router.post('/stats', controller.getStats);
  return router;
}
