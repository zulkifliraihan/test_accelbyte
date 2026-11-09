/** A single player's performance in one match (domain model, camelCase). */
export interface PlayerMatchResult {
  playerId: string;
  kills: number;
  won: boolean;
}

/** A finished match as reported by the game server. */
export interface MatchResult {
  matchId: string;
  durationSeconds: number;
  players: PlayerMatchResult[];
}

/** What the repository needs to persist a match. */
export interface MatchRecord extends MatchResult {
  /** Fingerprint of the canonical payload, used to detect conflicting re-submissions. */
  payloadHash: string;
}

/**
 * Per-match outcome of a batch write.
 *  - `inserted: true`  -> the match was new; it is now stored and folded into career stats.
 *  - `inserted: false` -> a match with the same id already existed (in the DB or earlier
 *    in the same batch); nothing was written. `existingPayloadHash` lets the service decide
 *    whether this is an idempotent retry or a conflicting submission.
 */
export type MatchWriteResult = { inserted: true } | { inserted: false; existingPayloadHash: string };

export interface IMatchRepository {
  /**
   * Persists a batch of matches in ONE atomic transaction: match rows, the per-player
   * ledger and the career-stat increments either all commit or none do.
   * Results are returned in the same order as the input.
   */
  recordMatches(matches: readonly MatchRecord[]): Promise<MatchWriteResult[]>;
}
