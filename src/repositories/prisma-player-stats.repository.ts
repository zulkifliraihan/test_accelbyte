import type { Prisma, PrismaClient, PlayerStats as PlayerStatsRow } from '../generated/prisma/client';
import type {
  IPlayerStatsRepository,
  LeaderboardRow,
  LeaderboardStat,
  PlayerStats,
} from '../interfaces/player-stats.repository.interface';
import { chunk } from '../utils/chunk';

const ID_LOOKUP_CHUNK = 1_000;

/** Public stat name -> ORDER BY clause (matches the composite indexes) and value accessor. */
const LEADERBOARD_QUERY: Record<
  LeaderboardStat,
  { orderBy: Prisma.PlayerStatsOrderByWithRelationInput[]; value: (row: PlayerStatsRow) => bigint }
> = {
  kills: { orderBy: [{ totalKills: 'desc' }, { playerId: 'asc' }], value: (r) => r.totalKills },
  wins: { orderBy: [{ totalWins: 'desc' }, { playerId: 'asc' }], value: (r) => r.totalWins },
  playtime: { orderBy: [{ totalPlaytimeSeconds: 'desc' }, { playerId: 'asc' }], value: (r) => r.totalPlaytimeSeconds },
};

/**
 * Totals are stored as SQLite INTEGER (64-bit) and surface as bigint. They are
 * converted to number at the repository boundary; Number.MAX_SAFE_INTEGER (~9e15)
 * is far beyond any realistic career total.
 */
const toNumber = (v: bigint | number): number => Number(v);

export class PrismaPlayerStatsRepository implements IPlayerStatsRepository {
  /** Uses the read-only connection: always sees a committed snapshot (WAL). */
  constructor(private readonly reader: PrismaClient) {}

  async findByPlayerIds(playerIds: readonly string[]): Promise<PlayerStats[]> {
    const out: PlayerStats[] = [];
    for (const ids of chunk(playerIds, ID_LOOKUP_CHUNK)) {
      const rows = await this.reader.playerStats.findMany({ where: { playerId: { in: ids } } });
      for (const r of rows) {
        out.push({
          playerId: r.playerId,
          totalKills: toNumber(r.totalKills),
          totalWins: toNumber(r.totalWins),
          totalPlaytimeSeconds: toNumber(r.totalPlaytimeSeconds),
          totalMatches: toNumber(r.totalMatches),
        });
      }
    }
    return out;
  }

  async findTopByStat(stat: LeaderboardStat, limit: number): Promise<LeaderboardRow[]> {
    const query = LEADERBOARD_QUERY[stat];
    // Walks the (stat DESC, player_id ASC) index and stops after `limit` rows - no sort, no full scan.
    const rows = await this.reader.playerStats.findMany({ orderBy: query.orderBy, take: limit });
    return rows.map((r) => ({ playerId: r.playerId, value: toNumber(query.value(r)) }));
  }
}
