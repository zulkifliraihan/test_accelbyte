import { z } from 'zod';
import { ID_MAX_LENGTH, ID_PATTERN } from './common';

export const MAX_PLAYERS_PER_MATCH = 64;
/** Sanity bounds that keep obviously corrupt reports out of career totals. */
export const MAX_MATCH_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const MAX_KILLS_PER_MATCH = 100_000;

const id = (name: string) =>
  z
    .string({ error: `${name} must be a string` })
    .min(1, { error: `${name} must not be empty` })
    .max(ID_MAX_LENGTH, { error: `${name} must be at most ${ID_MAX_LENGTH} characters` })
    .regex(ID_PATTERN, { error: `${name} must contain printable characters only (no whitespace)` });

const playerResultSchema = z.object({
  player_id: id('player_id'),
  kills: z
    .number({ error: 'kills must be a number' })
    .int({ error: 'kills must be an integer' })
    .min(0, { error: 'kills must be >= 0' })
    .max(MAX_KILLS_PER_MATCH, { error: `kills must be <= ${MAX_KILLS_PER_MATCH}` }),
  won: z.boolean({ error: 'won must be a boolean' }),
});

/**
 * Unknown fields are ignored (stripped) rather than rejected so that game servers can
 * roll out new fields before this service learns about them.
 */
export const submitMatchSchema = z
  .object({
    match_id: id('match_id'),
    duration_seconds: z
      .number({ error: 'duration_seconds must be a number' })
      .int({ error: 'duration_seconds must be an integer' })
      .min(0, { error: 'duration_seconds must be >= 0' })
      .max(MAX_MATCH_DURATION_SECONDS, { error: `duration_seconds must be <= ${MAX_MATCH_DURATION_SECONDS}` }),
    players: z
      .array(playerResultSchema, { error: 'players must be an array' })
      .min(1, { error: 'players must contain at least 1 entry' })
      .max(MAX_PLAYERS_PER_MATCH, { error: `players must contain at most ${MAX_PLAYERS_PER_MATCH} entries` }),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.players.forEach((p, index) => {
      if (seen.has(p.player_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['players', index, 'player_id'],
          message: `duplicate player_id '${p.player_id}' in the same match`,
        });
      }
      seen.add(p.player_id);
    });
  });

export type SubmitMatchBody = z.infer<typeof submitMatchSchema>;
