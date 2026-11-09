import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config/env';
import { createContainer, createPrismaRepositories, type Container } from '../../src/container';
import { createDatabase, type Database } from '../../src/db/prisma';
import { createLogger } from '../../src/observability/logger';
import { Metrics } from '../../src/observability/metrics';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

/** Applies the real Prisma migration files to a fresh SQLite file (same SQL as `prisma migrate deploy`). */
function applyMigrations(dbFile: string): void {
  const sqlite = new BetterSqlite3(dbFile);
  try {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const dir of dirs) sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8'));
  } finally {
    sqlite.close();
  }
}

export interface TestApp {
  app: Express;
  db: Database;
  container: Container;
  metrics: Metrics;
  close(): Promise<void>;
}

/** Spins up the full stack (real Prisma + SQLite) on an isolated temporary database. */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-stats-test-'));
  const dbFile = path.join(dir, 'test.db');
  applyMigrations(dbFile);

  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: `file:${dbFile}`, ...env });
  const logger = createLogger(config.log);
  const metrics = new Metrics({ collectDefault: false });
  const db = await createDatabase(config.databaseUrl, { synchronous: config.sqliteSynchronous });
  const container = createContainer({ config, repositories: createPrismaRepositories(db), metrics, logger });
  const app = createApp({ controllers: container.controllers, metrics, logger });

  return {
    app,
    db,
    container,
    metrics,
    async close() {
      await container.services.match.shutdown();
      await db.disconnect();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may briefly keep the file locked; the OS temp dir is cleaned eventually.
      }
    },
  };
}
