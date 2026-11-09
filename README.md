# Match Stats Service

Post-match stat aggregation service for a multiplayer game. Game servers submit match
results, and the service keeps each player's career totals (kills, wins, playtime)
and serves player profiles and leaderboards.

**Stack:** Node.js (≥ 22) · TypeScript · Express 5 · Prisma 7 · SQLite (WAL, `better-sqlite3`
driver adapter) · Zod · Pino · prom-client · Vitest

Design rationale, tradeoffs and measurements are in **[DECISIONS.md](./DECISIONS.md)**.

---

## 1. Run it

### Option A: Docker (recommended)

```bash
docker compose up --build
```

That's it. The container applies database migrations on start-up and listens on
`http://localhost:3000`. The SQLite database lives in the named volume `stats-data`, so
it survives restarts. To start from an empty database: `docker compose down -v`.

Optional: also start Prometheus (http://localhost:9090), already configured to scrape the service:

```bash
docker compose --profile monitoring up --build
```

### Option B: Node.js locally

Requires Node.js 22+ (developed on Node 24) and npm.

```bash
npm ci                      # install dependencies
cp .env.example .env        # optional - every setting has a default
npm run build               # prisma generate + tsc
npm start                   # prisma migrate deploy + node dist/src/server.js
```

Development mode with auto-reload: `npm run dev`.

> `better-sqlite3`, `prisma` and `esbuild` need their install scripts. They are pre-approved
> in the `allowScripts` field of `package.json` (npm ≥ 11), so `npm ci` needs no extra steps.

---

## 2. Verify the test cases

The seven test cases from the assignment are covered in three ways.

### 2.1 Automated test suite (no running server needed)

```bash
npm test
```

Runs 64 tests against the real stack (Express + Prisma + SQLite, temporary database per file):

| File | What it covers |
|---|---|
| `tests/e2e/spec-test-cases.test.ts` | Test cases 1 to 7 in order, plus a 409 conflict case |
| `tests/e2e/concurrency.test.ts` | 480 concurrent submissions over a shared player pool (exact totals), 50 identical racing submissions, racing conflicting payloads, no torn reads during writes |
| `tests/e2e/validation-and-errors.test.ts` | 400 / 404 / 409 / 413 / 415 / 503 behaviour, health and metrics endpoints |
| `tests/unit/*.test.ts` | Group-commit queue, idempotency rules, ranking and tie-breaking (using in-memory fake repositories) |

### 2.2 Script against a running service

Start the service (Docker or `npm start`) against an **empty** database, then run:

```bash
# Docker (no local Node.js needed)
docker compose exec stats-service node dist/scripts/verify-test-cases.js

# Local
npm run verify                                  # default BASE_URL=http://localhost:3000
BASE_URL=http://localhost:3000 npm run verify
```

Expected output:

```
PASS  Case 1: POST /matches (match 1)
PASS  Case 2: POST /matches (match 2)
PASS  Case 3: POST /players/stats [player-A, player-B, player-C]
PASS  Case 4: GET /leaderboard?stat=kills&limit=2
PASS  Case 5: POST /matches (match 1 again) -> 200 duplicate, stats unchanged
PASS  Case 6: POST /players/stats [player-A, player-unknown] -> unknown gets zeroes
PASS  Case 7: GET /leaderboard?stat=wins&limit=2 -> tie, both rank 1, player_id ASC
7/7 test cases passed
```

### 2.3 Manually with curl

```bash
# Case 1
curl -s -X POST localhost:3000/matches -H 'Content-Type: application/json' -d '{
  "match_id":"match-1","duration_seconds":1800,
  "players":[{"player_id":"player-A","kills":10,"won":true},{"player_id":"player-B","kills":4,"won":false}]}'
# -> 200 {"match_id":"match-1","status":"recorded"}

# Case 2
curl -s -X POST localhost:3000/matches -H 'Content-Type: application/json' -d '{
  "match_id":"match-2","duration_seconds":2400,
  "players":[{"player_id":"player-A","kills":6,"won":false},{"player_id":"player-C","kills":15,"won":true}]}'
# -> 200 {"match_id":"match-2","status":"recorded"}

# Case 3
curl -s -X POST localhost:3000/players/stats -H 'Content-Type: application/json' \
  -d '{"player_ids":["player-A","player-B","player-C"]}'
# -> player-A 16/1/4200, player-B 4/0/1800, player-C 15/1/2400

# Case 4
curl -s 'localhost:3000/leaderboard?stat=kills&limit=2'
# -> rank 1 player-A (16), rank 2 player-C (15)

# Case 5: repeat the Case 1 command
# -> 200 {"match_id":"match-1","status":"duplicate"}   (stats unchanged)

# Case 6
curl -s -X POST localhost:3000/players/stats -H 'Content-Type: application/json' \
  -d '{"player_ids":["player-A","player-unknown"]}'
# -> player-unknown returned with all totals = 0

# Case 7
curl -s 'localhost:3000/leaderboard?stat=wins&limit=2'
# -> player-A and player-C, both rank 1 (tie), ordered by player_id
```

On Windows PowerShell, use `curl.exe` (not the `curl` alias) or `Invoke-RestMethod`.

### 2.4 Load / concurrency check against a running service

```bash
npm run loadtest                                           # 2000 matches, 200 concurrent clients
MATCHES=5000 CONCURRENCY=500 PLAYERS_PER_MATCH=64 npm run loadtest
docker compose exec stats-service node dist/scripts/load-test.js
```

The load test submits matches whose players overlap heavily (the same player appears in
many concurrent submissions), re-submits about 10% of them concurrently as retries, then
checks every player's totals against locally computed sums. It exits non-zero on any
mismatch. All its IDs are prefixed with a random run id, so it does not touch other data.
It does add players, though, so run `verify` first if you use the same database.

---

## 3. API

All bodies are JSON. Errors always have this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid match result",
             "details": [{ "field": "players.0.kills", "message": "kills must be >= 0" }],
             "request_id": "6c1f..." } }
```

### `POST /matches`: submit a match result

| Field | Rule |
|---|---|
| `match_id` | string, 1 to 128 printable characters, no whitespace |
| `duration_seconds` | integer, 0 to 604800 (7 days) |
| `players` | 1 to 64 entries, `player_id` unique within the match |
| `players[].player_id` | same rule as `match_id` |
| `players[].kills` | integer, 0 to 100000 |
| `players[].won` | boolean |

Unknown fields are ignored.

| Status | When |
|---|---|
| `200 {"match_id": "...", "status": "recorded"}` | New match, committed and aggregated |
| `200 {"match_id": "...", "status": "duplicate"}` | Same `match_id` with an identical payload was already recorded. Nothing changes (idempotent retry). Player order does not matter. |
| `409 MATCH_ID_CONFLICT` | Same `match_id` was recorded with **different** content. Nothing changes. |
| `400 VALIDATION_ERROR` / `INVALID_JSON` | Invalid input |
| `413 PAYLOAD_TOO_LARGE` | Body > 256 KB |
| `415 UNSUPPORTED_MEDIA_TYPE` | Content-Type is not `application/json` |
| `503 SERVICE_UNAVAILABLE` + `Retry-After` | Write queue full (load shedding) or shutting down |

A `200` is sent only after the transaction containing the match has committed. The
stats are durable and visible to reads at that point.

### `POST /players/stats`: career stats for players

Request: `{"player_ids": ["...", ...]}` with 1 to 100 ids.

Response: one entry per **distinct** id, in request order:

```json
{ "players": [ { "player_id": "player-A", "total_kills": 16, "total_wins": 1,
                 "total_playtime_seconds": 4200, "total_matches": 2 } ] }
```

Players with no recorded match are returned with all totals `0` (see DECISIONS.md §6).
`total_matches` is an extra field that lets clients tell "never played" from "played and scored 0".

### `GET /leaderboard?stat=<kills|wins|playtime>&limit=<N>`

`stat` is required. `limit` is optional: an integer from 1 to 100, default 10.

```json
{ "leaderboard": [ { "rank": 1, "player_id": "player-A", "stat": "wins", "value": 1 },
                   { "rank": 1, "player_id": "player-C", "stat": "wins", "value": 1 } ] }
```

**Tie-breaking:** standard competition ranking ("1-2-2-4"). Players with equal values share
a rank, and the next distinct value skips the ranks the tie used. Within a tie, entries
are ordered by `player_id` ascending, so the order is deterministic.

### Operational endpoints

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness: the process is up |
| `GET /readyz` | Readiness: DB reachable, write queue open, not shutting down. Returns `503` otherwise. |
| `GET /metrics` | Prometheus metrics |

---

## 4. Observability

- **Structured logs** (Pino, JSON to stdout): one access-log line per request with method,
  URL, status and latency. 4xx requests log at `warn`, 5xx at `error`. Unexpected errors log
  with their stack. `LOG_PRETTY=true` gives human-readable logs in development.
- **Request correlation:** every request gets an `X-Request-Id`. An incoming header is reused
  if present. The id is echoed in the response header, attached to every log line, and
  included in error bodies.
- **Prometheus metrics** (`/metrics`):

  | Metric | Meaning |
  |---|---|
  | `http_request_duration_seconds{method,route,status_code}` | Latency histogram / RED metrics |
  | `match_submissions_total{outcome}` | `recorded`, `duplicate`, `conflict`, `rejected`, `error` |
  | `match_player_results_aggregated_total` | Player results folded into career stats |
  | `write_batch_size` | Matches per SQLite transaction (group-commit efficiency) |
  | `write_batch_duration_seconds{result}` | Commit latency per batch |
  | `write_queue_depth` | Submissions waiting for the writer (saturation signal) |
  | `write_queue_rejections_total{reason}` | Load shedding (`queue_full`, `shutting_down`) |
  | `process_*`, `nodejs_*` | CPU, memory, GC, event-loop lag |

- **Health probes** for orchestrators, a Docker `HEALTHCHECK` on `/readyz`, and **graceful
  shutdown**. On SIGTERM the service fails readiness, stops accepting connections, commits
  everything already queued, then closes the database.

---

## 5. Configuration

All settings are environment variables. See `.env.example`.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `development` / `production` / `test` |
| `LOG_LEVEL` | `info` | `fatal` … `trace`, `silent` |
| `LOG_PRETTY` | `true` in development | Pretty-print logs |
| `DATABASE_URL` | `file:./data/stats.db` | SQLite file (`/data/stats.db` in Docker) |
| `SQLITE_SYNCHRONOUS` | `FULL` | `FULL` = fsync every commit; `NORMAL` = faster, not power-loss safe |
| `WRITE_BATCH_MAX_SIZE` | `200` | Max matches per transaction |
| `WRITE_QUEUE_MAX_PENDING` | `10000` | Queued submissions before returning 503 |
| `PLAYER_STATS_MAX_IDS` | `100` | Max `player_ids` per stats request |
| `LEADERBOARD_DEFAULT_LIMIT` / `LEADERBOARD_MAX_LIMIT` | `10` / `100` | Leaderboard size |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Graceful-shutdown deadline |

---

## 6. Project structure

Requests flow **route → controller → service → interface → repository → db**:

```
src/
├── server.ts                 # bootstrap, graceful shutdown, process-level error hooks
├── app.ts                    # Express app: middleware pipeline + routes + error handler
├── container.ts              # composition root (manual dependency injection)
├── config/env.ts             # validated environment configuration
├── routes/                   # HTTP routing only
├── controllers/              # HTTP <-> domain: validate input, map snake_case DTOs
├── services/                 # business rules: idempotency, ranking, group commit
├── interfaces/               # domain types + repository contracts (IMatchRepository, ...)
├── repositories/             # Prisma/SQLite implementations of the contracts
├── db/prisma.ts              # writer/reader PrismaClients, SQLite pragmas
├── validators/               # Zod request schemas
├── middlewares/              # request logging, metrics, JSON guard, error handling
├── observability/            # logger + Prometheus metrics
├── errors/                   # typed AppError hierarchy -> HTTP status codes
└── utils/                    # BatchQueue (group commit), payload hash, chunk
prisma/
├── schema.prisma             # data model
└── migrations/               # SQL migrations (applied on start-up)
scripts/                      # verify-test-cases.ts, load-test.ts
tests/                        # unit (fake repositories) + e2e (real SQLite)
```

| Command | Description |
|---|---|
| `npm run dev` | Generate client, migrate, run with auto-reload |
| `npm run build` | Generate Prisma client and compile to `dist/` |
| `npm start` | Apply migrations and start the compiled server |
| `npm test` | Run the full test suite |
| `npm run typecheck` | TypeScript type check |
| `npm run verify` | Check the 7 assignment test cases against a running service |
| `npm run loadtest` | Concurrency/correctness load test against a running service |
"# test_accelbyte" 
