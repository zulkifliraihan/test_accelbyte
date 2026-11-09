export const LEADERBOARD_STATS = ['kills', 'wins', 'playtime'] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];

/** Career totals for one player across every match they have played. */
export interface PlayerStats {
  playerId: string;
  totalKills: number;
  totalWins: number;
  totalPlaytimeSeconds: number;
  totalMatches: number;
}

export interface LeaderboardRow {
  playerId: string;
  value: number;
}

export interface IPlayerStatsRepository {
  /** Returns stats only for players that have at least one recorded match (order not guaranteed). */
  findByPlayerIds(playerIds: readonly string[]): Promise<PlayerStats[]>;

  /**
   * Top `limit` players for a stat, ordered by value DESC then player_id ASC
   * (deterministic order inside a tie).
   */
  findTopByStat(stat: LeaderboardStat, limit: number): Promise<LeaderboardRow[]>;
}
