import { Router } from 'express';
import type { Controllers } from '../container';
import { healthRoutes } from './health.routes';
import { leaderboardRoutes } from './leaderboard.routes';
import { matchRoutes } from './match.routes';
import { playerStatsRoutes } from './player-stats.routes';

export function apiRoutes(controllers: Controllers): Router {
  const router = Router();
  router.use('/', healthRoutes(controllers.health));
  router.use('/matches', matchRoutes(controllers.match));
  router.use('/players', playerStatsRoutes(controllers.playerStats));
  router.use('/leaderboard', leaderboardRoutes(controllers.leaderboard));
  return router;
}
