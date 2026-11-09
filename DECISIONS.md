# Design Decisions

This document explains the significant choices behind the service, the alternatives I
considered, and what I would change with more time.

**Requirements recap:** the workload is write-heavy. Thousands of match results can arrive
concurrently, each with up to 64 players, and the same player can appear in many
concurrent submissions. Stats must be consistent and queryable at all times, and the
service must be observable, containerised and must not crash on errors.

---

## 1. Architecture and layering

```
HTTP ─► route ─► controller ─► service ─► interface ◄─ repository ─► Prisma ─► SQLite
         │          │             │           │             │
      routing   validation &   business    contracts    persistence
       only     DTO mapping     rules     (no Prisma)   (SQL lives here only)
```

- **Routes** only bind paths to controller methods.
- **Controllers** own the HTTP contract: Zod validation, snake_case ↔ camelCase mapping,
  status codes. They contain no business logic.
- **Services** own the rules: idempotency semantics (duplicate vs conflict), ranking and
  tie-breaking, unknown-player behaviour, and the write pipeline (group commit, back-pressure).
- **Interfaces** (`src/interfaces/`) define domain types and repository contracts. Services
  depend only on these, never on Prisma.
- **Repositories** implement the contracts with Prisma on SQLite.
- **`container.ts`** is the composition root. Dependency injection is done by hand through
  constructors; no DI framework is needed at this size.

The unit tests make the payoff concrete: services run against an in-memory fake that
implements the same interfaces (`tests/helpers/fakes.ts`). Moving to Postgres or Redis
would mean writing a new repository; no service code would change.

One judgement call: the decision *duplicate vs conflict* lives in the service, but it needs
the "does this match exist?" check to be atomic with the insert. So the repository reports
facts (`inserted`, or `existingPayloadHash`) from inside its transaction, and the service
decides what they mean. The rule stays in the service, and the race-free check stays in the database.

---

## 2. Storage structure

Three tables (`prisma/schema.prisma`):

| Table | Purpose | Key |
|---|---|---|
| `matches` | One row per accepted match: `duration_seconds`, `payload_hash`, `player_count`, `created_at` | PK `match_id` |
| `match_players` | Immutable ledger: one row per (match, player) with `kills`, `won` | PK `(match_id, player_id)` |
| `player_stats` | Pre-aggregated career totals: kills, wins, playtime, matches | PK `player_id` + 3 leaderboard indexes |

**Pre-aggregated totals, not computed on read.** Reads (profiles, leaderboards) are served
from `player_stats` directly: O(1) per player and an index walk for the top-N. Computing
totals with `SUM … GROUP BY` over the ledger would make every read cost grow with match history.

**Why keep the ledger?** It is the audit trail and the source of truth. If an aggregation
bug is found, or a new stat (K/D, win-rate per period) is added, totals can be rebuilt with
one `GROUP BY` over `match_players`. It also makes a duplicate player within a match
impossible at the storage level, through its composite primary key. The cost is write
amplification: up to 64 extra rows per match. That is acceptable here because rows are
inserted in bulk inside the same transaction (§3). If write volume became a problem, the
ledger could move to an append-only log or event stream instead.

**Indexes.** `player_stats` has `(total_kills DESC, player_id)`, `(total_wins DESC, player_id)`
and `(total_playtime_seconds DESC, player_id)`. Each one exactly matches the leaderboard
`ORDER BY <stat> DESC, player_id ASC LIMIT N`, so SQLite reads N index entries and stops
(no sort, no scan). I deliberately did **not** index `match_players.player_id`: nothing
reads it today, and on a write-heavy table every index costs write throughput.

**Types.** Totals are `BIGINT` (SQLite 64-bit INTEGER) so they cannot overflow 32 bits. They
are converted to JS `number` at the repository boundary, which is exact up to 2^53, far
beyond any plausible career total.

**`payload_hash`.** SHA-256 of a canonical form of the match (`match_id`, duration, players
sorted by `player_id`). It distinguishes an idempotent retry from a conflicting re-use of a
`match_id` without storing or comparing the full payload.

**SQLite settings.** WAL journal mode, so readers never block the writer and vice versa.
`foreign_keys = ON`. `synchronous = FULL` by default (§5).

---

## 3. Concurrency model

### The constraint

SQLite allows **one writer at a time**. Two common approaches perform badly under the
stated load:

1. **One transaction per request, issued concurrently.** Requests contend for the write lock
   and hit `SQLITE_BUSY`/timeouts, and every match pays a full transaction plus fsync.
2. **Read-modify-write in application code** (`SELECT total` → add in JS → `UPDATE`). This
   loses updates when the same player is in two concurrent matches.

### What I built: single-flight group commit (`src/utils/batch-queue.ts`)

```
request ─┐                            ┌─► one SQLite transaction ─► resolve each request
request ─┼─► BatchQueue (in memory) ──┤    (up to 200 matches)
request ─┘      bounded, FIFO         └─► next batch = everything that arrived meanwhile
```

- **Single-flight.** At most one write transaction is in progress at any time, so SQLite's
  write lock is never contended. Serialisation happens in-process, in a FIFO queue, instead
  of through lock retries.
- **Adaptive batching (group commit).** While one batch commits, new submissions accumulate
  and form the next batch. At low load a batch is one match (lowest latency). At high load
  batches grow automatically and the transaction/fsync cost is shared across up to
  `WRITE_BATCH_MAX_SIZE` matches. No timers or tuning are needed.
- **Atomic increments in SQL.** Each batch folds its matches into one delta per player and
  applies all deltas with a single
  `INSERT … ON CONFLICT(player_id) DO UPDATE SET total_kills = total_kills + excluded.total_kills, …`.
  The arithmetic happens inside the database within the transaction, so updates cannot be
  lost. A player in 20 matches of the same batch costs one row update, not 20.
- **Bulk statements via `json_each`.** The batch is sent as **one JSON parameter** and
  expanded by SQLite (`INSERT … SELECT … FROM json_each(?)`). The SQL text stays small and
  constant, SQLite's bound-parameter limit is never reached, and no chunking is needed.
  Values are still bound, never concatenated, so there is no injection risk.
- **Back-pressure.** The queue is bounded (`WRITE_QUEUE_MAX_PENDING`). When it is full,
  requests fail fast with `503 + Retry-After` instead of letting memory and latency grow
  without limit. This is standard load shedding, and game servers are expected to retry.
- **Failure isolation.** If a multi-match batch fails, each of its matches is retried in its
  own transaction. One bad item fails only its own request, not 199 unrelated ones.

### Reader/writer connection split

The Prisma `better-sqlite3` adapter uses **one connection per PrismaClient**. While reading
its source I found that non-transactional queries are **not** serialised against an open
interactive transaction on that connection. A `GET /leaderboard` arriving between two
statements of a write batch would run *inside* the uncommitted transaction and could
observe a half-applied batch.

So `db/prisma.ts` opens two connections:

- `writer`: used only by the write queue.
- `reader`: a separate, `query_only` connection for all reads. With WAL, it always sees the
  last committed snapshot.

`tests/e2e/concurrency.test.ts › reads stay consistent while writes are in flight` checks
this. Every match gives players `a` and `b` identical deltas, and 100 reads issued during
200 concurrent writes must never see their totals differ.

### Why not a mutex or per-player locks?

A mutex around per-request transactions would also be correct, but it pays one transaction
plus fsync per match. Per-player locks only help when the database supports concurrent
writers, which SQLite does not. Group commit is correct and also the fastest option for a
single-writer store.

---

## 4. Consistency approach

| Guarantee | How |
|---|---|
| **Atomic per match** | Match row, ledger rows and stat increments are written in the same transaction. A partially applied match is impossible. |
| **Exactly-once aggregation per `match_id`** | Existence check and insert run in the same serialised transaction. The `matches` primary key is a second line of defence. Duplicates *within* one batch are detected too. |
| **No lost updates** | Increments are computed by SQLite (`x = x + excluded.x`) inside the transaction, with no read-modify-write in JS. |
| **Read-your-writes** | `POST /matches` responds only after its batch has **committed**. Any read issued after the 200 sees the match. |
| **Snapshot reads** | Reads use a separate WAL connection. They see a consistent committed state and never an in-progress batch. |
| **Durability** | `synchronous = FULL`: a 200 survives an OS crash or power loss (§5). |

Because everything is synchronously consistent there is no eventual-consistency window:
leaderboards and profiles reflect a match as soon as its submission returns.

---

## 5. Tradeoffs considered

| Decision | Alternatives | Why this one |
|---|---|---|
| **SQLite** (required stack) | Postgres, Redis sorted sets | Zero-ops and embedded, with ACID transactions and enough throughput for one node. The downside is a single writer and single node, so the service scales vertically only. The repository interfaces keep a later move to Postgres local to the repository layer. |
| **Group commit queue** | Per-request transactions, mutex | See §3: contention-free and amortises fsync. Cost: a write waits for the batch in flight (~10 ms locally), which is invisible next to network latency. |
| **Pre-aggregated totals** | Aggregate on read | Reads dominate in product terms (profiles, leaderboards) and must be cheap. The cost moves to the write path, where batching absorbs it. |
| **Ledger table** | Totals only | Auditability and the ability to rebuild totals, at the cost of write amplification (§2). |
| **`synchronous = FULL`** default | `NORMAL` | A `200` should mean durable. Group commit amortises the fsync. `NORMAL` stays safe if the process or container crashes (only an OS crash or power cut can lose the last commits) and is available via `SQLITE_SYNCHRONOUS=NORMAL`. In my measurements the difference was small (§8), because fsync is not the bottleneck. |
| **Raw SQL for the bulk write** | Prisma `createMany` / `upsert` | Measured: `createMany` took ~660 ms for 5,760 ledger rows, a hand-written bulk insert ~70 ms. Prisma's `upsert` has no `x = x + excluded.x` form for a whole batch. Prisma is still used for the client, schema, migrations, transactions and all reads. |
| **Prisma** (required stack) | Using `better-sqlite3` directly | Type-safe client and migrations. Measured cost: a batch takes ~9.5 ms through Prisma's interactive transaction vs ~4.6 ms with raw `better-sqlite3` (§8). |
| **Shared rank on ties** (1-2-2-4) | Unique ranks (1-2-3-4) with an arbitrary tie-breaker | Showing two players with the same value as rank 1 and rank 2 suggests a difference that does not exist. Competition ranking is the convention in sports and most game leaderboards. Ordering *inside* a tie is by `player_id` so responses are deterministic and stable. |
| **Duplicate = 200 / conflict = 409** | Always 409; always 200 | Game servers retry on timeouts, and a retry must be safe (200, no double counting). Re-using a `match_id` with different data points to a bug or tampering, so it must be visible (409) and must not silently overwrite history. |
| **Unknown player = zeros** | 404, or leaving them out | The service does not own player identity, so it cannot tell a typo from a player who has not finished a match yet. Zeros match the truth ("no recorded stats"), keep the response shape stable for batch lookups, and `total_matches = 0` makes the distinction explicit. |
| **Ignore unknown JSON fields** | Reject (`strict`) | Lets game servers ship new fields before this service is updated. Unknown fields are not part of the payload hash. |
| **Bounded queue + 503** | Unbounded queue | Under overload, bounded latency and memory plus explicit retry signals beat timeouts and running out of memory. |
| **Express 5** | Fastify | Express was required. Express 5 forwards async errors to the error handler natively, which removes a common cause of crashes. |

---

## 6. Edge cases

| Case | Behaviour |
|---|---|
| **Case 5:** same `match_id` re-submitted, identical payload | `200 {"status":"duplicate"}`, stats unchanged. Player order is ignored (canonical hash). |
| Same `match_id`, **different** payload | `409 MATCH_ID_CONFLICT`, stats unchanged. |
| Same `match_id` submitted concurrently (×50) | Exactly one `recorded`, the rest `duplicate` (or `409` if payloads differ). Tested. |
| **Case 6:** unknown `player_id` in stats request | Returned with all totals `0` and `total_matches: 0`. |
| Duplicate ids in `player_ids` | Deduplicated, first-occurrence order kept. |
| **Case 7:** tie on the leaderboard | Shared rank, then `player_id` ascending. Example: `player-A` and `player-C` both rank 1 for wins. |
| `limit` cut through a tie | The list is truncated deterministically by `player_id`. Ranks stay correct. |
| Same player listed twice in one match | `400`: it would double-count, and the ledger primary key forbids it. |
| `players` empty or > 64 | `400` |
| Negative, fractional or non-numeric `kills` / `duration_seconds` | `400` |
| Implausible values (`kills` > 100k, duration > 7 days) | `400`. Sanity bounds keep corrupt reports out of career totals. |
| `duration_seconds = 0` | Accepted (for example an aborted match). Counts as a match played with 0 playtime. |
| IDs with whitespace or control characters, or > 128 chars | `400`. IDs are opaque, so UUIDs and `player-A` are both valid. |
| Malformed JSON / wrong Content-Type / body > 256 KB | `400 INVALID_JSON` / `415` / `413` |
| Missing or invalid `stat`; `limit` ≤ 0, > 100, non-numeric or repeated | `400` (explicit error rather than silent clamping) |
| Unknown route or method | `404` JSON |
| Write queue full / shutting down | `503` with `Retry-After` |
| Leaderboard with no data | `200 {"leaderboard": []}` |

---

## 7. Error handling strategy

- **Typed errors.** `AppError` subclasses (`ValidationError` 400, `ConflictError` 409,
  `UnsupportedMediaTypeError` 415, `ServiceUnavailableError` 503, …) carry their HTTP status
  and machine-readable `code`. Services throw them, and one error middleware turns them into
  a consistent JSON body: `{error: {code, message, details?, request_id}}`.
- **Validation at the edge.** Zod schemas in controllers return *all* problems at once, with
  field paths (`players.3.kills`).
- **Unexpected errors.** Logged with stack trace and request id, then returned as an opaque
  `500 INTERNAL_ERROR` with the `request_id` so the client can report it. Internals are never leaked.
- **The process does not crash on request errors.** Express 5 routes rejected promises to the
  error middleware. Body-parser failures map to 400/413/415. Batch failures are isolated per
  item (§3). `unhandledRejection` is logged. `uncaughtException` triggers a *graceful*
  shutdown, because the process state is unknown and a supervisor restart is safer than
  continuing.
- **Graceful shutdown.** On SIGTERM: fail `/readyz` → stop accepting connections → drain the
  write queue (every accepted match is committed and answered) → close the database. A
  deadline (`SHUTDOWN_TIMEOUT_MS`) prevents hanging forever.

---

## 8. Measurements

These are local measurements on a Windows 11 laptop, with the load generator on the same
machine, using the compiled build (`node dist/src/server.js`) and `scripts/load-test.ts`.
They are indicative, not a benchmark.

| Scenario | Result |
|---|---|
| 3,000 matches × **64 players** + ~10% concurrent retries, 300 concurrent clients | ~250 to 350 req/s across runs (~16k to 22k player results/s), p50 ≈ 0.7 s at saturation. **0 lost or double-counted updates.** |
| 5,000 matches × 10 players + retries, 500 concurrent clients | ~380 to 425 req/s. **Totals exact.** |
| Same with `SQLITE_SYNCHRONOUS=NORMAL` | Within noise of `FULL`: fsync is not the bottleneck. |
| Bulk ledger insert, 5,760 rows | Prisma `createMany` ≈ 660 ms → bulk SQL ≈ 70 ms |
| One batch (8 matches × 64 players) | Through Prisma ≈ 9.5 ms; raw `better-sqlite3` ≈ 4.6 ms |

A CPU profile under load shows the single Node.js process is the limit: SQLite execution
(synchronous in `better-sqlite3`), Prisma's transaction machinery, and HTTP/JSON handling.
It is not lock contention. Correctness holds under all tested concurrency levels.

---

## 9. What I would improve with more time

1. **Take SQLite work off the event loop.** `better-sqlite3` is synchronous, so each commit
   blocks HTTP handling for a few milliseconds. Running the writer in a `worker_thread`, or
   using raw `better-sqlite3` prepared statements for the hot write path (≈2× in the
   measurement above), would raise throughput and flatten tail latency.
2. **Horizontal scale.** SQLite pins the service to one node. For multiple replicas I would
   move to Postgres with the same pattern (`INSERT … ON CONFLICT DO UPDATE SET x = x + …`,
   `match_id` unique constraint), or put a durable queue (Kafka/NATS) in front, partitioned
   by match, with idempotent consumers. Leaderboards could then be served from Redis sorted
   sets updated by the same consumers.
3. **Durable intake.** Matches currently queue in memory. A crash loses queued submissions
   whose requests had not been answered yet; clients will retry, but a write-ahead intake
   log or broker would make acceptance itself durable.
4. **Distributed tracing** (OpenTelemetry spans for HTTP → service → batch → SQL), plus
   ready-made Grafana dashboards and alerts (queue depth, 5xx rate, batch latency, p99).
5. **Pagination** for leaderboards (`offset`/cursor) and a `GET /players/:id/rank` endpoint
   (`COUNT(*) WHERE stat > value` on the same indexes).
6. **Security and operations:** authentication for game servers (mTLS or signed requests),
   rate limiting per game server, and backup/restore of the SQLite file (Litestream).
7. **Property-based tests** (random interleavings of submissions and retries checked against
   a model) and a sustained soak test in the container.
8. **Time-windowed stats** (daily/weekly/season leaderboards) derived from the ledger.
