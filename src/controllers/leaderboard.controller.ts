import type { Request, Response } from 'express';
import type { LeaderboardService } from '../services/leaderboard.service';
import { parseOrThrow } from '../validators/common';
import { createLeaderboardQuerySchema } from '../validators/leaderboard.validator';

export class LeaderboardController {
  private readonly schema: ReturnType<typeof createLeaderboardQuerySchema>;

  constructor(
    private readonly leaderboardService: LeaderboardService,
    limits: { defaultLimit: number; maxLimit: number },
  ) {
    this.schema = createLeaderboardQuerySchema(limits);
  }

  /** GET /leaderboard?stat=<kills|wins|playtime>&limit=<N> */
  get = async (req: Request, res: Response): Promise<void> => {
    const query = parseOrThrow(this.schema, req.query, 'Invalid leaderboard query');

    const entries = await this.leaderboardService.getLeaderboard(query.stat, query.limit);

    res.status(200).json({
      leaderboard: entries.map((e) => ({
        rank: e.rank,
        player_id: e.playerId,
        stat: e.stat,
        value: e.value,
      })),
    });
  };
}
