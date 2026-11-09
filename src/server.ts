import 'dotenv/config';
import type { Server } from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config/env';
import { createContainer, createPrismaRepositories } from './container';
import { createDatabase, type Database } from './db/prisma';
import { createLogger, type Logger } from './observability/logger';
import { Metrics } from './observability/metrics';
import type { Services } from './container';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.log);
  const metrics = new Metrics();

  const db = await createDatabase(config.databaseUrl, { synchronous: config.sqliteSynchronous });
  const { services, controllers } = createContainer({
    config,
    repositories: createPrismaRepositories(db),
    metrics,
    logger,
  });
  const app = createApp({ controllers, metrics, logger });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'match-stats-service listening');
  });
  // Keep-alive must outlive typical load-balancer idle timeouts to avoid 502s on reused sockets.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  installShutdownHandlers({ server, services, db, logger, timeoutMs: config.shutdownTimeoutMs });
}

function installShutdownHandlers(ctx: {
  server: Server;
  services: Services;
  db: Database;
  logger: Logger;
  timeoutMs: number;
}): void {
  const { server, services, db, logger, timeoutMs } = ctx;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'graceful shutdown started');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(exitCode || 1);
    }, timeoutMs);
    force.unref();

    try {
      // 1. Fail readiness so the orchestrator stops sending traffic.
      services.health.markShuttingDown();
      // 2. Stop accepting connections; in-flight requests keep running.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      // 3. Commit everything already queued, then wait for responses to flush.
      await services.match.shutdown();
      await closed;
      // 4. Release the database (checkpoints the WAL).
      await db.disconnect();
      logger.info('graceful shutdown complete');
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      exitCode = exitCode || 1;
    } finally {
      clearTimeout(force);
      logger.flush?.();
      process.exit(exitCode);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));

  // Request-level errors never reach here (Express catches them). These handlers exist so
  // that a bug outside the request path is logged with context instead of dying silently.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    // State may be corrupt: drain what we can, then exit and let the supervisor restart us.
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}

main().catch((err: unknown) => {
  // Logger may not exist yet (e.g. invalid configuration), so fall back to stderr.
  console.error('failed to start match-stats-service', err);
  process.exit(1);
});
