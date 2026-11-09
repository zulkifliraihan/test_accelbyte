import { createHash } from 'node:crypto';
import type { MatchResult } from '../interfaces/match.repository.interface';

/**
 * Deterministic fingerprint of a match result. Player order is irrelevant to the
 * outcome of a match, so players are sorted first: a retry that lists players in a
 * different order is still recognised as the same submission.
 */
export function hashMatchPayload(match: MatchResult): string {
  const players = [...match.players]
    .sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0))
    .map((p) => [p.playerId, p.kills, p.won]);

  const canonical = JSON.stringify([match.matchId, match.durationSeconds, players]);
  return createHash('sha256').update(canonical).digest('hex');
}
