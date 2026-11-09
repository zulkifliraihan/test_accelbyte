import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchBody } from '../helpers/fakes';
import { createTestApp, type TestApp } from '../helpers/test-app';

describe('Validation and error handling', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const valid = () => matchBody('m-valid', 100, [['p1', 1, true]]);

  it.each([
    ['missing match_id', { ...valid(), match_id: undefined }, 'match_id'],
    ['empty match_id', { ...valid(), match_id: '' }, 'match_id'],
    ['match_id with whitespace', { ...valid(), match_id: 'a b' }, 'match_id'],
    ['negative duration', { ...valid(), duration_seconds: -1 }, 'duration_seconds'],
    ['fractional duration', { ...valid(), duration_seconds: 1.5 }, 'duration_seconds'],
    ['duration as string', { ...valid(), duration_seconds: '100' }, 'duration_seconds'],
    ['empty players', { ...valid(), players: [] }, 'players'],
    ['players not an array', { ...valid(), players: {} }, 'players'],
    ['negative kills', matchBody('m', 1, [['p1', -1, true]]), 'players.0.kills'],
    ['won not boolean', { ...valid(), players: [{ player_id: 'p1', kills: 1, won: 'yes' }] }, 'players.0.won'],
    ['duplicate player in match', matchBody('m', 1, [['p1', 1, true], ['p1', 2, false]]), 'players.1.player_id'],
  ])('POST /matches rejects %s with 400', async (_name, body, field) => {
    const res = await request(t.app).post('/matches').send(body as object);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  it('accepts exactly 64 players and rejects 65', async () => {
    const players = (n: number) => Array.from({ length: n }, (_, i) => [`p${i}`, 1, i % 2 === 0] as [string, number, boolean]);

    const ok = await request(t.app).post('/matches').send(matchBody('m-64', 10, players(64)));
    expect(ok.status).toBe(200);

    const tooMany = await request(t.app).post('/matches').send(matchBody('m-65', 10, players(65)));
    expect(tooMany.status).toBe(400);
  });

  it('ignores unknown fields (forward compatible)', async () => {
    const res = await request(t.app)
      .post('/matches')
      .send({ ...matchBody('m-extra', 10, [['p1', 1, true]]), map: 'dust2' });
    expect(res.status).toBe(200);
  });

  it('rejects malformed JSON with 400 INVALID_JSON', async () => {
    const res = await request(t.app).post('/matches').set('Content-Type', 'application/json').send('{"match_id":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects non-JSON content type with 415', async () => {
    const res = await request(t.app).post('/matches').set('Content-Type', 'text/plain').send('hello');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await request(t.app)
      .post('/matches')
      .send({ ...valid(), padding: 'x'.repeat(300 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it.each([
    [{}, 'player_ids'],
    [{ player_ids: [] }, 'player_ids'],
    [{ player_ids: 'player-A' }, 'player_ids'],
    [{ player_ids: [1] }, 'player_ids.0'],
    [{ player_ids: Array.from({ length: 101 }, (_, i) => `p${i}`) }, 'player_ids'],
  ])('POST /players/stats rejects %j with 400', async (body, field) => {
    const res = await request(t.app).post('/players/stats').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  it.each([
    ['/leaderboard', 'stat'],
    ['/leaderboard?stat=deaths', 'stat'],
    ['/leaderboard?stat=kills&limit=0', 'limit'],
    ['/leaderboard?stat=kills&limit=-3', 'limit'],
    ['/leaderboard?stat=kills&limit=abc', 'limit'],
    ['/leaderboard?stat=kills&limit=101', 'limit'],
    ['/leaderboard?stat=kills&limit=1&limit=2', 'limit'],
  ])('GET %s -> 400', async (url, field) => {
    const res = await request(t.app).get(url);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  it('defaults limit to 10', async () => {
    const res = await request(t.app).get('/leaderboard?stat=kills');
    expect(res.status).toBe(200);
    expect(res.body.leaderboard.length).toBeLessThanOrEqual(10);
  });

  it('returns 404 JSON for unknown routes and wrong methods', async () => {
    const a = await request(t.app).get('/does-not-exist');
    expect(a.status).toBe(404);
    expect(a.body.error.code).toBe('NOT_FOUND');

    const b = await request(t.app).get('/matches');
    expect(b.status).toBe(404);
  });

  it('echoes X-Request-Id and includes it in error bodies', async () => {
    const res = await request(t.app).get('/leaderboard').set('X-Request-Id', 'trace-123');
    expect(res.headers['x-request-id']).toBe('trace-123');
    expect(res.body.error.request_id).toBe('trace-123');
  });

  it('exposes liveness, readiness and Prometheus metrics', async () => {
    expect((await request(t.app).get('/healthz')).status).toBe(200);

    const ready = await request(t.app).get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ database: 'ok', write_queue: 'ok', shutting_down: false });

    const metrics = await request(t.app).get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('match_submissions_total');
    expect(metrics.text).toContain('http_request_duration_seconds');
  });
});

describe('Shutdown behaviour', () => {
  it('rejects new submissions with 503 + Retry-After and reports not-ready after shutdown starts', async () => {
    const t = await createTestApp();
    try {
      t.container.services.health.markShuttingDown();
      await t.container.services.match.shutdown();

      const res = await request(t.app).post('/matches').send(matchBody('late', 10, [['p', 1, true]]));
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBeDefined();

      const ready = await request(t.app).get('/readyz');
      expect(ready.status).toBe(503);
    } finally {
      await t.close();
    }
  });
});
