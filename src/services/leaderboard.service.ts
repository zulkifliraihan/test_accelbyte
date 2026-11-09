import type { IPlayerStatsRepository, LeaderboardStat } from '../interfaces/player-stats.repository.interface';

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  stat: LeaderboardStat;
  value: number;
}

export class LeaderboardService {
  constructor(private readonly playerStatsRepository: IPlayerStatsRepository) {}

  /**
   * Top `limit` players by `stat`.
   *
   * Tie-breaking ("standard competition ranking", 1-2-2-4):
   *  - players with the same value share the same rank;
   *  - the next distinct value skips the ranks consumed by the tie;
   *  - inside a tie, players are listed by player_id ascending so the order is
   *    deterministic and stable between calls (and pagination-safe).
   */
  async getLeaderboard(stat: LeaderboardStat, limit: number): Promise<LeaderboardEntry[]> {
    const rows = await this.playerStatsRepository.findTopByStat(stat, limit);

    const entries: LeaderboardEntry[] = [];
    let rank = 0;
    rows.forEach((row, index) => {
      const previous = rows[index - 1];
      if (previous === undefined || previous.value !== row.value) rank = index + 1;
      entries.push({ rank, playerId: row.playerId, stat, value: row.value });
    });
    return entries;
  }
}
