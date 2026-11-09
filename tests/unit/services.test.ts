import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, ServiceUnavailableError } from '../../src/errors/app-error';
import { createLogger } from '../../src/observability/logger';
import { Metrics } from '../../src/observability/metrics';
import { LeaderboardService } from '../../src/services/leaderboard.service';
import { MatchService } from '../../src/services/match.service';
import { PlayerStatsService } from '../../src/services/player-stats.service';
import { hashMatchPayload } from '../../src/utils/payload-hash';
import { InMemoryStatsStore } from '../helpers/fakes';

const logger = createLogger({ level: 'silent', pretty: false });

const match = (matchId: string, durationSeconds: number, players: Array<[string, number, boolean]>) => ({
  matchId,
  durationSeconds,
  players: players.map(([playerId, kills, won]) => ({ playerId, kills, won })),
});

describe('MatchService', () => {
  let store: InMemoryStatsStore;
  let service: MatchService;

  beforeEach(() => {
    store = new InMemoryStatsStore();
    service = new MatchService(store, { maxBatchSize: 50, maxPending: 100 }, new Metrics({ collectDefault: false }), logger);
  });

  it('records a new match', async () => {
    await expect(service.submitMatch(match('m1', 60, [['a', 1, true]]))).resolves.toEqual({
      matchId: 'm1',
      status: 'recorded',
    });
    expect(store.stats.get('a')).toMatchObject({ totalKills: 1, totalWins: 1, totalPlaytimeSeconds: 60 });
  });

  it('treats an identical re-submission as an idempotent duplicate (no double counting)', async () => {
    await service.submitMatch(match('m1', 60, [['a', 1, true], ['b', 2, false]]));
    // Same content, players listed in a different order.
    const again = await service.submitMatch(match('m1', 60, [['b', 2, false], ['a', 1, true]]));

    expect(again.status).toBe('duplicate');
    expect(store.stats.get('a')?.totalKills).toBe(1);
  });

  it('rejects a re-used match_id with a different payload with ConflictError', async () => {
    await service.submitMatch(match('m1', 60, [['a', 1, true]]));
    await expect(service.submitMatch(match('m1', 60, [['a', 99, true]]))).rejects.toBeInstanceOf(ConflictError);
    expect(store.stats.get('a')?.totalKills).toBe(1);
  });

  it('resolves concurrent submissions of the same match to exactly one "recorded"', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.submitMatch(match('m1', 60, [['a', 1, true]]))),
    );
    expect(results.filter((r) => r.status === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(19);
    expect(store.stats.get('a')?.totalMatches).toBe(1);
  });

  it('batches concurrent submissions', async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => service.submitMatch(match(`m${i}`, 10, [['a', 1, false]]))));
    expect(store.batches.length).toBeLessThan(30);
    expect(store.stats.get('a')?.totalMatches).toBe(30);
  });

  it('returns 503 (ServiceUnavailableError) once shut down', async () => {
    await service.shutdown();
    await expect(service.submitMatch(match('m1', 60, [['a', 1, true]]))).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('propagates repository failures', async () => {
    store.failNext = new Error('disk full');
    await expect(service.submitMatch(match('m1', 60, [['a', 1, true]]))).rejects.toThrow('disk full');
  });
});

describe('hashMatchPayload', () => {
  it('ignores player order but not content', () => {
    const a = hashMatchPayload(match('m', 10, [['x', 1, true], ['y', 2, false]]));
    const b = hashMatchPayload(match('m', 10, [['y', 2, false], ['x', 1, true]]));
    const c = hashMatchPayload(match('m', 11, [['x', 1, true], ['y', 2, false]]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('PlayerStatsService', () => {
  it('returns zeroed stats for unknown players, dedupes ids and keeps request order', async () => {
    const store = new InMemoryStatsStore();
    await store.recordMatches([{ ...match('m1', 100, [['a', 5, true]]), payloadHash: 'h' }]);
    const service = new PlayerStatsService(store);

    const result = await service.getStats(['ghost', 'a', 'ghost']);

    expect(result).toEqual([
      { playerId: 'ghost', totalKills: 0, totalWins: 0, totalPlaytimeSeconds: 0, totalMatches: 0 },
      { playerId: 'a', totalKills: 5, totalWins: 1, totalPlaytimeSeconds: 100, totalMatches: 1 },
    ]);
  });
});

describe('LeaderboardService', () => {
  const setup = async (kills: Record<string, number>) => {
    const store = new InMemoryStatsStore();
    await store.recordMatches(
      Object.entries(kills).map(([id, k], i) => ({ ...match(`m${i}`, 10, [[id, k, false]]), payloadHash: `${i}` })),
    );
    return new LeaderboardService(store);
  };

  it('uses standard competition ranking (1-2-2-4) with player_id ASC inside ties', async () => {
    const service = await setup({ d: 5, c: 9, b: 9, a: 10 });

    const board = await service.getLeaderboard('kills', 10);

    expect(board.map((e) => [e.rank, e.playerId, e.value])).toEqual([
      [1, 'a', 10],
      [2, 'b', 9],
      [2, 'c', 9],
      [4, 'd', 5],
    ]);
  });

  it('shares rank 1 when the leaders are tied', async () => {
    const service = await setup({ z: 3, y: 3, x: 1 });
    const board = await service.getLeaderboard('kills', 2);
    expect(board.map((e) => [e.rank, e.playerId])).toEqual([
      [1, 'y'],
      [1, 'z'],
    ]);
  });

  it('returns an empty leaderboard when there is no data', async () => {
    const service = new LeaderboardService(new InMemoryStatsStore());
    await expect(service.getLeaderboard('wins', 5)).resolves.toEqual([]);
  });
});
