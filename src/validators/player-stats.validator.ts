import { z } from 'zod';
import { ID_MAX_LENGTH, ID_PATTERN } from './common';

export function createPlayerStatsSchema(maxIds: number) {
  return z.object({
    player_ids: z
      .array(
        z
          .string({ error: 'player_id must be a string' })
          .min(1, { error: 'player_id must not be empty' })
          .max(ID_MAX_LENGTH, { error: `player_id must be at most ${ID_MAX_LENGTH} characters` })
          .regex(ID_PATTERN, { error: 'player_id must contain printable characters only (no whitespace)' }),
        { error: 'player_ids must be an array' },
      )
      .min(1, { error: 'player_ids must contain at least 1 entry' })
      .max(maxIds, { error: `player_ids must contain at most ${maxIds} entries` }),
  });
}

export type PlayerStatsBody = z.infer<ReturnType<typeof createPlayerStatsSchema>>;
