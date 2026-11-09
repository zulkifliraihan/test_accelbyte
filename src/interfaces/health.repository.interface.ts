export interface IHealthRepository {
  /** Resolves when the database answers a trivial query, rejects otherwise. */
  ping(): Promise<void>;
}
