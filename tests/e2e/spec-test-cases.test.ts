import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchBody } from '../helpers/fakes';
import { createTestApp, type TestApp } from '../helpers/test-app';

/** The seven test cases from the technical test document, executed in order against the real stack. */
describe('Spec test cases (sequential)', () => {
  let t: TestApp;

  const match1 = matchBody('match-1', 1800, [
    ['player-A', 10, true],
    ['player-B', 4, false],
  ]);
  const match2 = matchBody('match-2', 2400, [
    ['player-A', 6, false],
    ['player-C', 15, true],
  ]);

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('Case 1: POST /matches (match 1) -> 200', async () => {
    const res = await request(t.app).post('/matches').send(match1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ match_id: 'match-1', status: 'recorded' });
  });

  it('Case 2: POST /matches (match 2) -> 200', async () => {
    const res = await request(t.app).post('/matches').send(match2);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ match_id: 'match-2', status: 'recorded' });
  });

  it('Case 3: POST /players/stats returns accumulated career stats', async () => {
    const res = await request(t.app)
      .post('/players/stats')
      .send({ player_ids: ['player-A', 'player-B', 'player-C'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      players: [
        { player_id: 'player-A', total_kills: 16, total_wins: 1, total_playtime_seconds: 4200, total_matches: 2 },
        { player_id: 'player-B', total_kills: 4, total_wins: 0, total_playtime_seconds: 1800, total_matches: 1 },
        { player_id: 'player-C', total_kills: 15, total_wins: 1, total_playtime_seconds: 2400, total_matches: 1 },
      ],
    });
  });

  it('Case 4: GET /leaderboard?stat=kills&limit=2', async () => {
    const res = await request(t.app).get('/leaderboard?stat=kills&limit=2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      leaderboard: [
        { rank: 1, player_id: 'player-A', stat: 'kills', value: 16 },
        { rank: 2, player_id: 'player-C', stat: 'kills', value: 15 },
      ],
    });
  });

  it('Case 5: re-submitting match 1 is an idempotent no-op (200, status=duplicate, stats unchanged)', async () => {
    const res = await request(t.app).post('/matches').send(match1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ match_id: 'match-1', status: 'duplicate' });

    const stats = await request(t.app).post('/players/stats').send({ player_ids: ['player-A', 'player-B'] });
    expect(stats.body.players[0]).toMatchObject({ total_kills: 16, total_wins: 1, total_playtime_seconds: 4200 });
    expect(stats.body.players[1]).toMatchObject({ total_kills: 4, total_wins: 0, total_playtime_seconds: 1800 });
  });

  it('Case 5b: re-using match_id with DIFFERENT content -> 409 and stats unchanged', async () => {
    const tampered = matchBody('match-1', 1800, [
      ['player-A', 99, true],
      ['player-B', 4, false],
    ]);
    const res = await request(t.app).post('/matches').send(tampered);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MATCH_ID_CONFLICT');

    const stats = await request(t.app).post('/players/stats').send({ player_ids: ['player-A'] });
    expect(stats.body.players[0].total_kills).toBe(16);
  });

  it('Case 6: unknown players are returned with zeroed stats', async () => {
    const res = await request(t.app)
      .post('/players/stats')
      .send({ player_ids: ['player-A', 'player-unknown'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      players: [
        { player_id: 'player-A', total_kills: 16, total_wins: 1, total_playtime_seconds: 4200, total_matches: 2 },
        { player_id: 'player-unknown', total_kills: 0, total_wins: 0, total_playtime_seconds: 0, total_matches: 0 },
      ],
    });
  });

  it('Case 7: GET /leaderboard?stat=wins&limit=2 -> tie shares rank 1, ordered by player_id', async () => {
    const res = await request(t.app).get('/leaderboard?stat=wins&limit=2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      leaderboard: [
        { rank: 1, player_id: 'player-A', stat: 'wins', value: 1 },
        { rank: 1, player_id: 'player-C', stat: 'wins', value: 1 },
      ],
    });
  });

  it('playtime leaderboard sums each player\'s own matches', async () => {
    const res = await request(t.app).get('/leaderboard?stat=playtime');
    expect(res.body.leaderboard.map((e: { player_id: string; value: number }) => [e.player_id, e.value])).toEqual([
      ['player-A', 4200],
      ['player-C', 2400],
      ['player-B', 1800],
    ]);
  });
});
