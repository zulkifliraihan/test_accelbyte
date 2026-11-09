import type { Request, Response } from 'express';
import type { MatchService } from '../services/match.service';
import { parseOrThrow } from '../validators/common';
import { submitMatchSchema } from '../validators/match.validator';

export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  /** POST /matches */
  submit = async (req: Request, res: Response): Promise<void> => {
    const body = parseOrThrow(submitMatchSchema, req.body, 'Invalid match result');

    const result = await this.matchService.submitMatch({
      matchId: body.match_id,
      durationSeconds: body.duration_seconds,
      players: body.players.map((p) => ({ playerId: p.player_id, kills: p.kills, won: p.won })),
    });

    res.status(200).json({ match_id: result.matchId, status: result.status });
  };
}
