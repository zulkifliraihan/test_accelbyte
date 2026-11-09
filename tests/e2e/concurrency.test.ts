import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchBody } from '../helpers/fakes';
import { createTestApp, type TestApp } from '../helpers/test-app';

interface Totals {
  kills: number;
  wins: number;
  playtime: number;
  matches: number;
}

/** Deterministic pseudo-random generator so failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe('Concurrent submissions', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp({ WRITE_BATCH_MAX_SIZE: '50' });
  });
  afterEach(async () => {
    await t.close();
  });

  it('never loses or double-counts updates when the same players appear in many concurrent matches', async () => {
    const random = rng(42);
    const pool = Array.from({ length: 12 }, (_, i) => `player-${i}`);
    const expected = new Map<string, Totals>();

    const matches = Array.from({ length: 400 }, (_, i) => {
      const players = [...pool].sort(() => random() - 0.5).slice(0, 8);
      const duration = 60 + Math.floor(random() * 3600);
      const body = matchBody(
        `match-${i}`,
        duration,
        players.map((id, idx) => [id, Math.floor(random() * 25), idx < 4] as [string, number, boolean]),
      );
      for (const p of body.players) {
        const e = expected.get(p.player_id) ?? { kills: 0, wins: 0, playtime: 0, matches: 0 };
        e.kills += p.kills;
        e.wins += p.won ? 1 : 0;
        e.playtime += duration;
        e.matches += 1;
        expected.set(p.player_id, e);
      }
      return body;
    });

    // Fire everything at once, plus a retry of every 5th match racing with the original.
    const submissions = [...matches, ...matches.filter((_, i) => i % 5 === 0)];
    const responses = await Promise.all(submissions.map((m) => request(t.app).post('/matches').send(m)));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.body.status === 'recorded')).toHaveLength(400);
    expect(responses.filter((r) => r.body.status === 'duplicate')).toHaveLength(80);

    const stats = await request(t.app).post('/players/stats').send({ player_ids: pool });
    for (const p of stats.body.players as Array<Record<string, number | string>>) {
      const e = expected.get(p.player_id as string)!;
      expect(p).toEqual({
        player_id: p.player_id,
        total_kills: e.kills,
        total_wins: e.wins,
        total_playtime_seconds: e.playtime,
        total_matches: e.matches,
      });
    }

    // Group commit actually happened.
    const metrics = await request(t.app).get('/metrics');
    const batchCount = Number(/write_batch_size_count\{[^}]*\} (\d+)/.exec(metrics.text)?.[1]);
    expect(batchCount).toBeLessThan(submissions.length);
  });

  it('records a match exactly once when 50 identical submissions race', async () => {
    const body = matchBody('race-1', 600, [
      ['x', 3, true],
      ['y', 1, false],
    ]);
    const responses = await Promise.all(Array.from({ length: 50 }, () => request(t.app).post('/matches').send(body)));

    expect(responses.filter((r) => r.body.status === 'recorded')).toHaveLength(1);
    expect(responses.filter((r) => r.body.status === 'duplicate')).toHaveLength(49);

    const stats = await request(t.app).post('/players/stats').send({ player_ids: ['x'] });
    expect(stats.body.players[0]).toMatchObject({ total_kills: 3, total_wins: 1, total_playtime_seconds: 600, total_matches: 1 });
  });

  it('accepts exactly one of several conflicting payloads for the same match_id', async () => {
    const variants = Array.from({ length: 10 }, (_, k) => matchBody('race-2', 100, [['z', k, true]]));
    const responses = await Promise.all(variants.map((v) => request(t.app).post('/matches').send(v)));

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(9);

    const winner = variants[responses.findIndex((r) => r.status === 200)]!;
    const stats = await request(t.app).post('/players/stats').send({ player_ids: ['z'] });
    expect(stats.body.players[0].total_kills).toBe(winner.players[0]!.kills);
    expect(stats.body.players[0].total_matches).toBe(1);
  });

  it('reads stay consistent while writes are in flight (never a half-applied match)', async () => {
    // Every match gives both players exactly 1 kill, so at any committed point in time
    // a and b MUST have identical totals. A torn read would show them diverging.
    const writes = Array.from({ length: 200 }, (_, i) =>
      request(t.app)
        .post('/matches')
        .send(matchBody(`c-${i}`, 10, [['a', 1, true], ['b', 1, false]])),
    );
    const reads = Array.from({ length: 100 }, () =>
      request(t.app).post('/players/stats').send({ player_ids: ['a', 'b'] }),
    );

    const [, readResponses] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
    for (const r of readResponses) {
      const [a, b] = r.body.players;
      expect(a.total_kills).toBe(b.total_kills);
      expect(a.total_matches).toBe(b.total_matches);
    }
  });
});
