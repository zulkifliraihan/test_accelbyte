import type { Request, Response } from 'express';
import type { PlayerStatsService } from '../services/player-stats.service';
import { parseOrThrow } from '../validators/common';
import { createPlayerStatsSchema } from '../validators/player-stats.validator';

export class PlayerStatsController {
  private readonly schema: ReturnType<typeof createPlayerStatsSchema>;

  constructor(
    private readonly playerStatsService: PlayerStatsService,
    options: { maxIds: number },
  ) {
    this.schema = createPlayerStatsSchema(options.maxIds);
  }

  /** POST /players/stats */
  getStats = async (req: Request, res: Response): Promise<void> => {
    const body = parseOrThrow(this.schema, req.body, 'Invalid player stats request');

    const stats = await this.playerStatsService.getStats(body.player_ids);

    res.status(200).json({
      players: stats.map((s) => ({
        player_id: s.playerId,
        total_kills: s.totalKills,
        total_wins: s.totalWins,
        total_playtime_seconds: s.totalPlaytimeSeconds,
        total_matches: s.totalMatches,
      })),
    });
  };
}
