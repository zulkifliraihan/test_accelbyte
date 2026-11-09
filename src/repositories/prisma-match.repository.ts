import type { PrismaClient } from '../generated/prisma/client';
import type { IMatchRepository, MatchRecord, MatchWriteResult } from '../interfaces/match.repository.interface';

interface StatDelta {
  kills: number;
  wins: number;
  playtimeSeconds: number;
  matches: number;
}

/**
 * Write side of the match/stat storage.
 *
 * Bulk statements pass the whole batch as ONE JSON-encoded parameter and let SQLite
 * expand it with `json_each()`. Compared with Prisma's `createMany` (and with huge
 * multi-row `VALUES (?, ?, ...)` lists) this keeps the SQL text constant and tiny,
 * avoids SQLite's bound-parameter limit entirely (no chunking needed) and moved the
 * write path from ~800 ms to a few ms per 90-match batch in our measurements
 * (see DECISIONS.md). Values are still bound parameters - nothing is concatenated
 * into SQL, so there is no injection surface.
 */
export class PrismaMatchRepository implements IMatchRepository {
  constructor(
    private readonly writer: PrismaClient,
    private readonly options: { transactionTimeoutMs?: number } = {},
  ) {}

  async recordMatches(matches: readonly MatchRecord[]): Promise<MatchWriteResult[]> {
    if (matches.length === 0) return [];

    return this.writer.$transaction(
      async (tx) => {
        // 1. Which of these match ids are already stored?
        const uniqueIds = [...new Set(matches.map((m) => m.matchId))];
        const existing = await tx.$queryRaw<Array<{ match_id: string; payload_hash: string }>>`
          SELECT match_id, payload_hash
          FROM matches
          WHERE match_id IN (SELECT value FROM json_each(${JSON.stringify(uniqueIds)}))`;
        const known = new Map(existing.map((row) => [row.match_id, row.payload_hash]));

        // 2. Decide per match; the same id may also appear twice inside one batch.
        const results: MatchWriteResult[] = [];
        const toInsert: MatchRecord[] = [];
        for (const match of matches) {
          const existingPayloadHash = known.get(match.matchId);
          if (existingPayloadHash !== undefined) {
            results.push({ inserted: false, existingPayloadHash });
            continue;
          }
          known.set(match.matchId, match.payloadHash);
          toInsert.push(match);
          results.push({ inserted: true });
        }

        if (toInsert.length === 0) return results;

        // 3. Match rows (the primary key is the idempotency guard of last resort).
        const matchRows = toInsert.map((m) => [m.matchId, m.durationSeconds, m.payloadHash, m.players.length]);
        await tx.$executeRaw`
          INSERT INTO matches (match_id, duration_seconds, payload_hash, player_count, created_at)
          SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                 json_extract(value, '$[2]'), json_extract(value, '$[3]'), ${new Date()}
          FROM json_each(${JSON.stringify(matchRows)})`;

        // 4. Immutable per-player ledger.
        const ledgerRows = toInsert.flatMap((m) =>
          m.players.map((p) => [m.matchId, p.playerId, p.kills, p.won ? 1 : 0]),
        );
        await tx.$executeRaw`
          INSERT INTO match_players (match_id, player_id, kills, won)
          SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                 json_extract(value, '$[2]'), json_extract(value, '$[3]')
          FROM json_each(${JSON.stringify(ledgerRows)})`;

        // 5. Fold the whole batch into one delta per player, then apply all deltas with a
        //    single atomic `INSERT ... ON CONFLICT DO UPDATE SET x = x + excluded.x`.
        //    A player who appears in 20 matches of this batch costs one row write, not 20,
        //    and the increment happens inside SQLite (no read-modify-write in JS).
        const deltas = new Map<string, StatDelta>();
        for (const m of toInsert) {
          for (const p of m.players) {
            const d = deltas.get(p.playerId) ?? { kills: 0, wins: 0, playtimeSeconds: 0, matches: 0 };
            d.kills += p.kills;
            d.wins += p.won ? 1 : 0;
            d.playtimeSeconds += m.durationSeconds;
            d.matches += 1;
            deltas.set(p.playerId, d);
          }
        }
        const deltaRows = [...deltas].map(([playerId, d]) => [playerId, d.kills, d.wins, d.playtimeSeconds, d.matches]);

        // `WHERE true` disambiguates the ON CONFLICT clause after a SELECT (SQLite grammar).
        await tx.$executeRaw`
          INSERT INTO player_stats (player_id, total_kills, total_wins, total_playtime_seconds, total_matches)
          SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
                 json_extract(value, '$[3]'), json_extract(value, '$[4]')
          FROM json_each(${JSON.stringify(deltaRows)}) WHERE true
          ON CONFLICT (player_id) DO UPDATE SET
            total_kills            = total_kills            + excluded.total_kills,
            total_wins             = total_wins             + excluded.total_wins,
            total_playtime_seconds = total_playtime_seconds + excluded.total_playtime_seconds,
            total_matches          = total_matches          + excluded.total_matches`;

        return results;
      },
      {
        // The write queue guarantees a single in-flight transaction, so maxWait is never hit
        // in practice; timeout bounds a pathological batch.
        maxWait: 10_000,
        timeout: this.options.transactionTimeoutMs ?? 30_000,
      },
    );
  }
}
