import { Router } from 'express';
import type { LeaderboardController } from '../controllers/leaderboard.controller';

export function leaderboardRoutes(controller: LeaderboardController): Router {
  const router = Router();
  router.get('/', controller.get);
  return router;
}
