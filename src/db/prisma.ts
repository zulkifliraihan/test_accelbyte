import path from 'node:path';
import fs from 'node:fs';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client';

export type { PrismaClient };

/**
 * Two physical SQLite connections:
 *
 *  - `writer`: the ONLY connection that mutates data. All writes go through the
 *    single-flight write queue, so SQLite's single-writer lock is never contended.
 *  - `reader`: a separate, read-only connection. Because the database runs in WAL
 *    mode, reads on this connection see the last committed snapshot and are never
 *    blocked by - nor able to observe - an in-flight write transaction.
 *
 * Note: the better-sqlite3 adapter multiplexes everything over ONE connection per
 * PrismaClient, and non-transactional queries are not serialised against an open
 * interactive transaction. Splitting reader/writer is therefore also what
 * guarantees that a read never sees a half-applied batch.
 */
export interface Database {
  writer: PrismaClient;
  reader: PrismaClient;
  disconnect(): Promise<void>;
}

export function resolveSqlitePath(databaseUrl: string): string {
  const raw = databaseUrl.replace(/^file:/, '');
  if (raw === ':memory:') {
    throw new Error('In-memory SQLite is not supported: reader and writer need a shared database file');
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

export interface DatabaseOptions {
  synchronous?: 'FULL' | 'NORMAL';
}

export async function createDatabase(databaseUrl: string, options: DatabaseOptions = {}): Promise<Database> {
  const filePath = resolveSqlitePath(databaseUrl);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // `timeout` is better-sqlite3's busy timeout (ms) - a safety net only, since
  // there is a single writer per process.
  const writer = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: filePath, timeout: 5_000 }),
  });
  const reader = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: filePath, timeout: 5_000 }),
  });

  await writer.$connect();
  await reader.$connect();

  // journal_mode=WAL is persistent on the database file; the rest are per-connection.
  await writer.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  // FULL (default): a 200 response means the result is durable even across power loss.
  // Group commit amortises the fsync over the whole batch. Value is from a closed enum.
  const synchronous = options.synchronous ?? 'FULL';
  await writer.$executeRawUnsafe(`PRAGMA synchronous = ${synchronous === 'NORMAL' ? 'NORMAL' : 'FULL'}`);
  await writer.$executeRawUnsafe('PRAGMA foreign_keys = ON');
  await reader.$executeRawUnsafe('PRAGMA query_only = ON');

  return {
    writer,
    reader,
    async disconnect() {
      await Promise.allSettled([writer.$disconnect(), reader.$disconnect()]);
    },
  };
}
