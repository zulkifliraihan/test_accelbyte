import type { IMatchRepository, MatchRecord, MatchWriteResult } from '../../src/interfaces/match.repository.interface';
import type {
  IPlayerStatsRepository,
  LeaderboardRow,
  LeaderboardStat,
  PlayerStats,
} from '../../src/interfaces/player-stats.repository.interface';

/**
 * In-memory implementation of both repository interfaces. Used by the unit tests to
 * exercise the services without a database - the payoff of depending on interfaces.
 */
export class InMemoryStatsStore implements IMatchRepository, IPlayerStatsRepository {
  readonly matches = new Map<string, MatchRecord>();
  readonly stats = new Map<string, PlayerStats>();
  readonly batches: number[] = [];
  failNext: Error | null = null;

  async recordMatches(matches: readonly MatchRecord[]): Promise<MatchWriteResult[]> {
    this.batches.push(matches.length);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return matches.map((m) => {
      const existing = this.matches.get(m.matchId);
      if (existing) return { inserted: false, existingPayloadHash: existing.payloadHash };
      this.matches.set(m.matchId, m);
      for (const p of m.players) {
        const s = this.stats.get(p.playerId) ?? {
          playerId: p.playerId,
          totalKills: 0,
          totalWins: 0,
          totalPlaytimeSeconds: 0,
          totalMatches: 0,
        };
        s.totalKills += p.kills;
        s.totalWins += p.won ? 1 : 0;
        s.totalPlaytimeSeconds += m.durationSeconds;
        s.totalMatches += 1;
        this.stats.set(p.playerId, s);
      }
      return { inserted: true };
    });
  }

  async findByPlayerIds(playerIds: readonly string[]): Promise<PlayerStats[]> {
    return playerIds.flatMap((id) => {
      const s = this.stats.get(id);
      return s ? [{ ...s }] : [];
    });
  }

  async findTopByStat(stat: LeaderboardStat, limit: number): Promise<LeaderboardRow[]> {
    const pick = (s: PlayerStats) =>
      stat === 'kills' ? s.totalKills : stat === 'wins' ? s.totalWins : s.totalPlaytimeSeconds;
    return [...this.stats.values()]
      .map((s) => ({ playerId: s.playerId, value: pick(s) }))
      .sort((a, b) => b.value - a.value || (a.playerId < b.playerId ? -1 : 1))
      .slice(0, limit);
  }
}

/** Builds a match payload in the public (snake_case) API format. */
export function matchBody(
  matchId: string,
  durationSeconds: number,
  players: Array<[playerId: string, kills: number, won: boolean]>,
) {
  return {
    match_id: matchId,
    duration_seconds: durationSeconds,
    players: players.map(([player_id, kills, won]) => ({ player_id, kills, won })),
  };
}
