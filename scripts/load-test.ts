/**
 * Concurrency / correctness load test against a RUNNING service.
 *
 *   npm run loadtest                                  # defaults
 *   MATCHES=5000 CONCURRENCY=500 npm run loadtest     # heavier
 *
 * It submits MATCHES match results (PLAYERS_PER_MATCH players drawn from a small pool,
 * so the same player appears in many concurrent submissions), re-submits a share of
 * them concurrently as retries, then checks every player's career totals against the
 * totals computed locally. Exits with code 1 on any mismatch.
 *
 * All ids are prefixed with a random run id, so the test never collides with other data.
 */
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const MATCHES = Number(process.env.MATCHES ?? 2000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 200);
const PLAYERS_PER_MATCH = Math.min(64, Number(process.env.PLAYERS_PER_MATCH ?? 16));
const PLAYER_POOL = Math.max(PLAYERS_PER_MATCH, Number(process.env.PLAYER_POOL ?? 200));
const RETRY_RATIO = Number(process.env.RETRY_RATIO ?? 0.1);

interface Totals {
  kills: number;
  wins: number;
  playtime: number;
  matches: number;
}

const runId = randomUUID().slice(0, 8);
const pool = Array.from({ length: PLAYER_POOL }, (_, i) => `lt-${runId}-p${i}`);

function buildMatch(i: number) {
  const players = [...pool].sort(() => Math.random() - 0.5).slice(0, PLAYERS_PER_MATCH);
  return {
    match_id: `lt-${runId}-m${i}`,
    duration_seconds: 300 + Math.floor(Math.random() * 3000),
    players: players.map((player_id, idx) => ({
      player_id,
      kills: Math.floor(Math.random() * 30),
      won: idx % 2 === 0,
    })),
  };
}

async function main(): Promise<void> {
  const matches = Array.from({ length: MATCHES }, (_, i) => buildMatch(i));
  const retries = matches.filter(() => Math.random() < RETRY_RATIO);
  const submissions = [...matches, ...retries].sort(() => Math.random() - 0.5);

  const expected = new Map<string, Totals>();
  for (const m of matches) {
    for (const p of m.players) {
      const t = expected.get(p.player_id) ?? { kills: 0, wins: 0, playtime: 0, matches: 0 };
      t.kills += p.kills;
      t.wins += p.won ? 1 : 0;
      t.playtime += m.duration_seconds;
      t.matches += 1;
      expected.set(p.player_id, t);
    }
  }

  console.log(
    `run=${runId} submissions=${submissions.length} (unique=${MATCHES}, retries=${retries.length}) ` +
      `concurrency=${CONCURRENCY} players/match=${PLAYERS_PER_MATCH} pool=${PLAYER_POOL}`,
  );

  const statusCounts = new Map<string, number>();
  const latencies: number[] = [];
  let next = 0;

  const worker = async () => {
    while (next < submissions.length) {
      const body = submissions[next++];
      const started = performance.now();
      let key: string;
      try {
        const res = await fetch(`${BASE_URL}/matches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as { status?: string };
        key = `${res.status}${json.status ? ` ${json.status}` : ''}`;
      } catch (err) {
        key = `network-error ${(err as Error).message}`;
      }
      latencies.push(performance.now() - started);
      statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
    }
  };

  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedSec = (performance.now() - started) / 1000;

  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!.toFixed(1);
  console.log(`done in ${elapsedSec.toFixed(2)}s -> ${(submissions.length / elapsedSec).toFixed(0)} req/s`);
  console.log(`latency ms: p50=${pct(50)} p95=${pct(95)} p99=${pct(99)} max=${pct(100)}`);
  console.log('responses:', Object.fromEntries(statusCounts));

  // Verify every player's totals.
  let mismatches = 0;
  const ids = [...expected.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const res = await fetch(`${BASE_URL}/players/stats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player_ids: ids.slice(i, i + 100) }),
    });
    const json = (await res.json()) as {
      players: { player_id: string; total_kills: number; total_wins: number; total_playtime_seconds: number; total_matches: number }[];
    };
    for (const p of json.players) {
      const e = expected.get(p.player_id)!;
      if (
        p.total_kills !== e.kills ||
        p.total_wins !== e.wins ||
        p.total_playtime_seconds !== e.playtime ||
        p.total_matches !== e.matches
      ) {
        mismatches++;
        if (mismatches <= 5) console.error('MISMATCH', p, 'expected', e);
      }
    }
  }

  if (mismatches > 0) {
    console.error(`FAIL: ${mismatches}/${ids.length} players have wrong totals`);
    process.exit(1);
  }
  console.log(`OK: all ${ids.length} players' totals match exactly (no lost or double-counted updates)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
