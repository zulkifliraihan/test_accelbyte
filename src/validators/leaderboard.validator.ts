import { z } from 'zod';
import { LEADERBOARD_STATS } from '../interfaces/player-stats.repository.interface';

export function createLeaderboardQuerySchema(limits: { defaultLimit: number; maxLimit: number }) {
  return z.object({
    stat: z.enum(LEADERBOARD_STATS, { error: `stat is required and must be one of: ${LEADERBOARD_STATS.join(', ')}` }),
    limit: z
      .string({ error: 'limit must be a single integer' })
      .regex(/^\d+$/, { error: 'limit must be a positive integer' })
      .transform(Number)
      .pipe(
        z
          .number()
          .int()
          .min(1, { error: 'limit must be >= 1' })
          .max(limits.maxLimit, { error: `limit must be <= ${limits.maxLimit}` }),
      )
      .default(limits.defaultLimit),
  });
}

export type LeaderboardQuery = z.infer<ReturnType<typeof createLeaderboardQuerySchema>>;
