import type { IPlayerStatsRepository, PlayerStats } from '../interfaces/player-stats.repository.interface';

const emptyStats = (playerId: string): PlayerStats => ({
  playerId,
  totalKills: 0,
  totalWins: 0,
  totalPlaytimeSeconds: 0,
  totalMatches: 0,
});

export class PlayerStatsService {
  constructor(private readonly playerStatsRepository: IPlayerStatsRepository) {}

  /**
   * Returns one entry per distinct requested id, in request order.
   *
   * This service does not own player identity, so it cannot tell a mistyped id
   * from a real player who has not finished a match yet. Both are reported with
   * zeroed stats and `totalMatches = 0` instead of an error, which keeps the
   * response shape stable for profile pages and batch lookups.
   */
  async getStats(playerIds: readonly string[]): Promise<PlayerStats[]> {
    const unique = [...new Set(playerIds)];
    const found = await this.playerStatsRepository.findByPlayerIds(unique);
    const byId = new Map(found.map((s) => [s.playerId, s]));
    return unique.map((id) => byId.get(id) ?? emptyStats(id));
  }
}
