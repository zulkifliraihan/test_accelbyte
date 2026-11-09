/**
 * Runs the 7 test cases from the technical-test document against a RUNNING service
 * and prints PASS/FAIL for each one.
 *
 *   npm run verify                                   # http://localhost:3000
 *   BASE_URL=http://localhost:8080 npm run verify
 *   docker compose exec stats-service node dist/scripts/verify-test-cases.js
 *
 * Run it against an EMPTY database: the expected leaderboard values assume that
 * player-A/B/C are the only players. Re-running it is safe (submissions are
 * idempotent), but other data in the database may change the leaderboard.
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

interface Result {
  status: number;
  body: unknown;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Result> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, body: parsed };
}

const match1 = {
  match_id: 'match-1',
  duration_seconds: 1800,
  players: [
    { player_id: 'player-A', kills: 10, won: true },
    { player_id: 'player-B', kills: 4, won: false },
  ],
};

const match2 = {
  match_id: 'match-2',
  duration_seconds: 2400,
  players: [
    { player_id: 'player-A', kills: 6, won: false },
    { player_id: 'player-C', kills: 15, won: true },
  ],
};

type Check = { name: string; request: string; run: () => Promise<{ ok: boolean; got: Result }> };

const isDeepEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const stats = (id: string, kills: number, wins: number, playtime: number, matches: number) => ({
  player_id: id,
  total_kills: kills,
  total_wins: wins,
  total_playtime_seconds: playtime,
  total_matches: matches,
});

const checks: Check[] = [
  {
    name: 'Case 1',
    request: 'POST /matches (match 1)',
    run: async () => {
      const got = await call('POST', '/matches', match1);
      // 'duplicate' is also accepted so the script can be re-run against the same database.
      const status = (got.body as { status?: string }).status;
      return { ok: got.status === 200 && (status === 'recorded' || status === 'duplicate'), got };
    },
  },
  {
    name: 'Case 2',
    request: 'POST /matches (match 2)',
    run: async () => {
      const got = await call('POST', '/matches', match2);
      const status = (got.body as { status?: string }).status;
      return { ok: got.status === 200 && (status === 'recorded' || status === 'duplicate'), got };
    },
  },
  {
    name: 'Case 3',
    request: 'POST /players/stats [player-A, player-B, player-C]',
    run: async () => {
      const got = await call('POST', '/players/stats', { player_ids: ['player-A', 'player-B', 'player-C'] });
      const expected = {
        players: [
          stats('player-A', 16, 1, 4200, 2),
          stats('player-B', 4, 0, 1800, 1),
          stats('player-C', 15, 1, 2400, 1),
        ],
      };
      return { ok: got.status === 200 && isDeepEqual(got.body, expected), got };
    },
  },
  {
    name: 'Case 4',
    request: 'GET /leaderboard?stat=kills&limit=2',
    run: async () => {
      const got = await call('GET', '/leaderboard?stat=kills&limit=2');
      const expected = {
        leaderboard: [
          { rank: 1, player_id: 'player-A', stat: 'kills', value: 16 },
          { rank: 2, player_id: 'player-C', stat: 'kills', value: 15 },
        ],
      };
      return { ok: got.status === 200 && isDeepEqual(got.body, expected), got };
    },
  },
  {
    name: 'Case 5',
    request: 'POST /matches (match 1 again) -> 200 duplicate, stats unchanged',
    run: async () => {
      const got = await call('POST', '/matches', match1);
      const after = await call('POST', '/players/stats', { player_ids: ['player-A'] });
      const ok =
        got.status === 200 &&
        (got.body as { status?: string }).status === 'duplicate' &&
        isDeepEqual(after.body, { players: [stats('player-A', 16, 1, 4200, 2)] });
      return { ok, got };
    },
  },
  {
    name: 'Case 6',
    request: 'POST /players/stats [player-A, player-unknown] -> unknown gets zeroes',
    run: async () => {
      const got = await call('POST', '/players/stats', { player_ids: ['player-A', 'player-unknown'] });
      const expected = { players: [stats('player-A', 16, 1, 4200, 2), stats('player-unknown', 0, 0, 0, 0)] };
      return { ok: got.status === 200 && isDeepEqual(got.body, expected), got };
    },
  },
  {
    name: 'Case 7',
    request: 'GET /leaderboard?stat=wins&limit=2 -> tie, both rank 1, player_id ASC',
    run: async () => {
      const got = await call('GET', '/leaderboard?stat=wins&limit=2');
      const expected = {
        leaderboard: [
          { rank: 1, player_id: 'player-A', stat: 'wins', value: 1 },
          { rank: 1, player_id: 'player-C', stat: 'wins', value: 1 },
        ],
      };
      return { ok: got.status === 200 && isDeepEqual(got.body, expected), got };
    },
  },
];

async function main(): Promise<void> {
  console.log(`Verifying test cases against ${BASE_URL}\n`);
  let failed = 0;
  for (const check of checks) {
    try {
      const { ok, got } = await check.run();
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.name}: ${check.request}`);
      console.log(`      -> HTTP ${got.status} ${JSON.stringify(got.body)}`);
      if (!ok) failed++;
    } catch (err) {
      failed++;
      console.log(`FAIL  ${check.name}: ${check.request}\n      -> ${(err as Error).message}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} test cases passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
