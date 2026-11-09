import type { AppConfig } from './config/env';
import { HealthController } from './controllers/health.controller';
import { LeaderboardController } from './controllers/leaderboard.controller';
import { MatchController } from './controllers/match.controller';
import { PlayerStatsController } from './controllers/player-stats.controller';
import type { Database } from './db/prisma';
import type { IHealthRepository } from './interfaces/health.repository.interface';
import type { IMatchRepository } from './interfaces/match.repository.interface';
import type { IPlayerStatsRepository } from './interfaces/player-stats.repository.interface';
import type { Logger } from './observability/logger';
import type { Metrics } from './observability/metrics';
import { PrismaHealthRepository } from './repositories/prisma-health.repository';
import { PrismaMatchRepository } from './repositories/prisma-match.repository';
import { PrismaPlayerStatsRepository } from './repositories/prisma-player-stats.repository';
import { HealthService } from './services/health.service';
import { LeaderboardService } from './services/leaderboard.service';
import { MatchService } from './services/match.service';
import { PlayerStatsService } from './services/player-stats.service';

export interface Repositories {
  match: IMatchRepository;
  playerStats: IPlayerStatsRepository;
  health: IHealthRepository;
}

export interface Services {
  match: MatchService;
  playerStats: PlayerStatsService;
  leaderboard: LeaderboardService;
  health: HealthService;
}

export interface Controllers {
  match: MatchController;
  playerStats: PlayerStatsController;
  leaderboard: LeaderboardController;
  health: HealthController;
}

export interface Container {
  services: Services;
  controllers: Controllers;
}

/** Concrete Prisma/SQLite implementations of the repository interfaces. */
export function createPrismaRepositories(db: Database): Repositories {
  return {
    match: new PrismaMatchRepository(db.writer),
    playerStats: new PrismaPlayerStatsRepository(db.reader),
    health: new PrismaHealthRepository(db.reader),
  };
}

/**
 * Composition root: the only place that knows about concrete classes.
 * Services depend on repository *interfaces*, so tests (or a future Postgres/Redis
 * implementation) can plug in different repositories without touching business logic.
 */
export function createContainer(deps: {
  config: AppConfig;
  repositories: Repositories;
  metrics: Metrics;
  logger: Logger;
}): Container {
  const { config, repositories, metrics, logger } = deps;

  const matchService = new MatchService(repositories.match, config.writeQueue, metrics, logger);
  const services: Services = {
    match: matchService,
    playerStats: new PlayerStatsService(repositories.playerStats),
    leaderboard: new LeaderboardService(repositories.playerStats),
    health: new HealthService(repositories.health, () => matchService.isAcceptingWrites),
  };

  const controllers: Controllers = {
    match: new MatchController(services.match),
    playerStats: new PlayerStatsController(services.playerStats, { maxIds: config.limits.playerStatsMaxIds }),
    leaderboard: new LeaderboardController(services.leaderboard, {
      defaultLimit: config.limits.leaderboardDefaultLimit,
      maxLimit: config.limits.leaderboardMaxLimit,
    }),
    health: new HealthController(services.health, metrics),
  };

  return { services, controllers };
}
