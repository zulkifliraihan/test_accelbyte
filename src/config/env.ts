import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanish.optional(),

  DATABASE_URL: z.string().min(1).default('file:./data/stats.db'),
  /**
   * SQLite durability. FULL (default): every commit is fsync'ed - a 200 response survives
   * power loss. NORMAL: WAL is fsync'ed only at checkpoints - survives process/container
   * crashes, but an OS crash/power cut can roll back the last few commits. See DECISIONS.md.
   */
  SQLITE_SYNCHRONOUS: z.enum(['FULL', 'NORMAL']).default('FULL'),

  /** Maximum number of match results committed in a single SQLite transaction. */
  WRITE_BATCH_MAX_SIZE: z.coerce.number().int().min(1).max(5000).default(200),
  /** Back-pressure threshold: submissions beyond this many queued items get HTTP 503. */
  WRITE_QUEUE_MAX_PENDING: z.coerce.number().int().min(1).default(10_000),

  PLAYER_STATS_MAX_IDS: z.coerce.number().int().min(1).max(1000).default(100),
  LEADERBOARD_MAX_LIMIT: z.coerce.number().int().min(1).max(1000).default(100),
  LEADERBOARD_DEFAULT_LIMIT: z.coerce.number().int().min(1).default(10),

  /** How long a graceful shutdown may take before the process is force-exited. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
});

export type AppConfig = {
  env: 'development' | 'production' | 'test';
  port: number;
  log: { level: string; pretty: boolean };
  databaseUrl: string;
  sqliteSynchronous: 'FULL' | 'NORMAL';
  writeQueue: { maxBatchSize: number; maxPending: number };
  limits: {
    playerStatsMaxIds: number;
    leaderboardMaxLimit: number;
    leaderboardDefaultLimit: number;
  };
  shutdownTimeoutMs: number;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;

  if (e.LEADERBOARD_DEFAULT_LIMIT > e.LEADERBOARD_MAX_LIMIT) {
    throw new Error('LEADERBOARD_DEFAULT_LIMIT must not exceed LEADERBOARD_MAX_LIMIT');
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY ?? e.NODE_ENV === 'development' },
    databaseUrl: e.DATABASE_URL,
    sqliteSynchronous: e.SQLITE_SYNCHRONOUS,
    writeQueue: { maxBatchSize: e.WRITE_BATCH_MAX_SIZE, maxPending: e.WRITE_QUEUE_MAX_PENDING },
    limits: {
      playerStatsMaxIds: e.PLAYER_STATS_MAX_IDS,
      leaderboardMaxLimit: e.LEADERBOARD_MAX_LIMIT,
      leaderboardDefaultLimit: e.LEADERBOARD_DEFAULT_LIMIT,
    },
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  };
}
