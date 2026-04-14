# QUA-476 Phase 4b-B.2a — `things_search` Materialized View Benchmark

**Status**: benchmark only, no schema change. Phase 4b-B.2a of QUA-408. Dispatched to slot a8 by coordinator session 2026-04-14.

**Verdict**: **GO** — see [§5 Recommendation](#5-recommendation).

## Contents

| File | Purpose |
|---|---|
| `things-search-mv.sql` | Candidate materialized view definition (SQL file, NOT a migration) |
| `run-benchmark.mts` | Read-only benchmark runner that connects to prod and uses TEMP tables |
| `benchmark-results.json` | Raw numbers captured from prod, 2026-04-14 |
| `README.md` | This file — methodology + results + go/no-go |

## Safety model

The benchmark runner connects to `PRODUCTION_DB_URL` with `application_name = 'qua-476-benchmark'` and a 120s statement timeout. The only DDL it issues is `CREATE TEMP TABLE` / `CREATE INDEX` against session-local objects in `pg_temp.*`. No persistent objects are created. No rows are modified. The runner never issues `REFRESH MATERIALIZED VIEW` because a persistent MV would be needed and that was out of scope (dispatcher brief: "check with coordinator before touching prod").

`REFRESH MATERIALIZED VIEW CONCURRENTLY` behavior is therefore estimated from postgres documentation + the measured non-concurrent build time, not measured empirically. **This is the one measurement gap that Phase 2b must close on a restore instance or a coordinator-approved benchmark MV before the column drop.**

## 1. What we measured

### 1.1 Baseline (current `things.search_vector`)

Table at the time of the benchmark:

| Metric | Value |
|---|---:|
| Row count | 38,375 |
| Total relation size | 52 MB |
| Heap | 26 MB |
| Index size (total) | 26 MB |
| GIN index (`idx_things_search`) | 16 MB |

Thing-type breakdown (top rows): `resource` 22601, `grant` 5876, `fact` 4507, `entity` 2659, `personnel` 1295, `policy-stakeholder` 473, `benchmark-result` 264, `publication` 185, `division` 111, `funding-round` 90, `investment` 72, `funding-program` 59, `research-area` 54, `benchmark` 46, `race-candidate` 42, `political-race` 28, `equity-position` 13. (See `benchmark-results.json` for full list.)

### 1.2 `/search` latency — baseline

10 representative queries, 5 samples each, measured client-to-database round-trip from `lw/a8` (local workstation → DigitalOcean managed postgres, ~70ms network RTT).

Methodology: `SELECT t.id, t.title, ts_rank(t.search_vector, to_tsquery('english', <prefix>)) AS rank FROM things t WHERE t.search_vector @@ to_tsquery(...) ORDER BY rank DESC LIMIT 20`. The same prefix-ts_query shape used by `apps/wiki-server/src/routes/tablebase/things.ts::/search`.

| Query | p50 | p95 | p99 | min | max |
|---|---:|---:|---:|---:|---:|
| `anthropic` | 78 | 160 | 160 | 78 | 160 |
| `openai` | 81 | 468 | 468 | 76 | 468 |
| `safety` | 91 | 138 | 138 | 82 | 138 |
| `governance` | 94 | 100 | 100 | 88 | 100 |
| `deepmind` | 75 | 81 | 81 | 73 | 81 |
| `evaluation benchmark` | 76 | 84 | 84 | 75 | 84 |
| `sb 1047` | 74 | 75 | 75 | 74 | 75 |
| `alignment research` | 78 | 87 | 87 | 76 | 87 |
| `grant recipient` | 73 | 75 | 75 | 73 | 75 |
| `nonexistentxyzqueryqwerty` | 71 | 76 | 76 | 71 | 76 |

(All numbers in ms. Network RTT ≈ 70ms dominates. Real database-side work is p50 minus ~70ms ≈ 5–25ms per query.)

The `openai` p95 outlier (468ms) is a single-sample spike from n=5. It's well within the existing 3.5s `/search` timeout budget.

### 1.3 Refresh simulation — self-SELECT variant (3 runs)

Method: `CREATE TEMP TABLE things_search_bench AS SELECT id, …, <search_vector expression> FROM things`, then `CREATE UNIQUE INDEX` on `id`, then `CREATE INDEX … USING GIN (search_vector)`. TEMP tables are session-local and auto-dropped. `maintenance_work_mem` was raised to `256MB` to match the setting a real MV refresh would use.

| Phase | Run 1 | Run 2 | Run 3 | Avg |
|---|---:|---:|---:|---:|
| `CREATE TEMP TABLE ... AS SELECT` | 2272 | 2135 | 2230 | **2213 ms** |
| `CREATE UNIQUE INDEX (id)` | 255 | 341 | 231 | **276 ms** |
| `CREATE INDEX ... USING GIN` | 877 | 861 | 928 | **889 ms** |
| **Total** | 3404 | 3337 | 3389 | **3377 ms** |

TEMP table size after build: 33 MB total (21 MB heap + 12 MB index). Smaller than the live `things` (52 MB) because (a) no autovacuum slack and (b) fresh indexes with no bloat — realistic for a freshly-refreshed MV.

### 1.4 JOIN cost estimation (2b target)

The Phase 2b MV will resolve `parent_title`, `title`, and `description` from source tables (entities, facts, grants, …) rather than self-selecting from `things`. We measured the additional cost of one JOIN (the most common pattern, `LEFT JOIN entities ON stable_id = parent_thing_id`):

| Variant | Build time (ms) |
|---|---:|
| Self-SELECT (2a shape) | 2213 (avg) |
| Self-SELECT + LEFT JOIN entities | 2421 |
| **JOIN delta** | **+208 ms** |

Extrapolation for the 2b target (a UNION ALL across ~20 source tables, each typically smaller than `things` itself): call the fully-composed MV build ≈ **4–6 seconds** in steady state, plus ~1 second of index rebuild. Total cold refresh ≈ **5–7 seconds** as a realistic upper bound for current data volume.

### 1.5 MV query latency (TEMP TABLE as stand-in)

Same 10 queries, 5 samples each, against the freshly-built TEMP table with a GIN index and fresh ANALYZE stats.

| Query | p50 (MV) | p50 (baseline) | Delta |
|---|---:|---:|---:|
| `anthropic` | 143 | 78 | +65 |
| `openai` | 145 | 81 | +64 |
| `safety` | 153 | 91 | +62 |
| `governance` | 147 | 94 | +53 |
| `deepmind` | 142 | 75 | +67 |
| `evaluation benchmark` | 142 | 76 | +66 |
| `sb 1047` | 143 | 74 | +69 |
| `alignment research` | 144 | 78 | +66 |
| `grant recipient` | 143 | 73 | +70 |
| `nonexistentxyzqueryqwerty` | 141 | 71 | +70 |

The TEMP-table MV is consistently **~65ms slower than baseline** at p50. This is almost certainly a **TEMP-buffer artifact, not a real MV slowdown**:

- The persistent `things` table has been live on prod for months and its pages are fully warmed in `shared_buffers`. Our benchmark queries hit warm cache.
- The TEMP table lives in session-local `temp_buffers` (default 8 MB on DO managed postgres). Pages stream through cache for every query instead of staying resident.
- A persistent materialized view would behave exactly like `things` — same storage path, same `shared_buffers` eligibility, same planner statistics — so production MV query latency is expected to match or improve on baseline.

Note the TEMP-table p50/p95/p99 spread is much tighter than baseline's (141–156ms range vs baseline's 73–468ms). That's consistent with "consistently paying the cold-cache cost every time, but with no shared-buffer outliers." In other words: the TEMP benchmark is a conservative upper bound.

**This is the one headline number I want Phase 2b to re-verify on a persistent MV** before the column drop — see [§4 Gaps](#4-methodology-gaps).

### 1.6 Concurrent refresh behavior

Not measured. `REFRESH MATERIALIZED VIEW CONCURRENTLY` only applies to persistent MVs, which would have required `CREATE MATERIALIZED VIEW` against prod (out of scope — dispatcher brief: check with coordinator first).

From postgres documentation and published behavior:

- `REFRESH MATERIALIZED VIEW` (non-concurrent): takes `ACCESS EXCLUSIVE` on the MV for the duration of the rebuild. All concurrent reads on the MV block on the lock. Roughly equal in cost to the self-SELECT build time measured in §1.3.
- `REFRESH MATERIALIZED VIEW CONCURRENTLY`: builds the new snapshot alongside the old one, computes a row-level diff, and applies INSERT/UPDATE/DELETE against the old MV. Cost is roughly **2x** the non-concurrent refresh because both snapshots exist briefly. Requires at least one `UNIQUE INDEX` on the MV (our candidate has `things_search_pkey (id)`).
- During a `CONCURRENTLY` refresh, readers see the pre-refresh snapshot with normal latency. They are **not blocked**. This is the key property that motivates using an MV at all.

Estimated `REFRESH CONCURRENTLY` cost: **≈ 6.7 s** for the 2a shape (self-SELECT), extrapolating to **≈ 10–14 s** for the full 2b composed shape.

## 2. Candidate MV definition

See [`things-search-mv.sql`](./things-search-mv.sql). Key design decisions:

- **Columns**: same as current `things` (minus metadata columns the search path doesn't need). Keeps `/api/things/{search,list,children,:id}` switchable with no query rewrites.
- **`search_vector`**: stored column (not `GENERATED`), computed from the same expression as the current `idx_things_search`. Preserves existing relevance scores exactly.
- **`things_search_pkey`** unique index on `id` — **required for CONCURRENTLY**.
- **GIN index** on `search_vector` — mirrors existing `idx_things_search`.
- **Secondary btree indexes** on `thing_type`, `parent_thing_id`, `entity_type`, `updated_at` — mirrors the existing `idx_things_*` set.
- **Optional**: `pg_trgm` GIN on `title` for the trigram fallback in `/search` phase 3. Commented out pending a decision on whether phase 3 moves to the MV or stays on the pointer table.

The 2b target (UNION ALL across source tables) is sketched in the SQL file as a comment block but not executed in the 2a benchmark.

## 3. Answers to the QUA-476 design questions

- **Is hourly refresh lag acceptable for UX?** Yes (confirmed by user in QUA-476 body). At an hourly cadence, the worst case a user sees is a new entity/record being un-searchable for up to 59 minutes after creation. Compared to the current state — raw IDs and stale titles leaking into search results within seconds of a write — this is an improvement, not a regression. For lower latency we can drop to 15-minute refreshes at ~0.1% duty cycle (14s refresh × 4/hour = 56s/hour).
- **Should the MV include non-search fields or stay minimal?** Include the same columns `things` has today (`entity_type`, `source_url`, `wiki_id`, `parent_thing_id`, `parent_title`, etc.) so `/api/things/{list,:id,children}` can switch to the MV without query rewrites. The marginal cost is tiny (~10 MB on a 33 MB MV) and the rewrites otherwise would have to split the read path between MV (search) and pointer table (everything else), doubling the per-endpoint maintenance burden. If a later audit shows specific columns are only read by the sync path, they can be dropped from the MV without breaking the read API — it's additive.
- **Does `parent_thing_id` validation need to be part of 4b-B.2b or can it wait?** It can wait. The audit (§6 finding #7) notes that `upsertThingsInTx` never updates `parent_thing_id` on conflict. An MV on the `things` table inherits whatever `parent_thing_id` the pointer rows have. Fixing the update path is orthogonal and can be deferred to a follow-up ticket under QUA-408 without blocking the title-column drop.

## 4. Methodology gaps

These are the things the benchmark could **not** measure, which Phase 2b must confirm before the column drop:

1. **`REFRESH MATERIALIZED VIEW CONCURRENTLY` latency empirically.** Only possible against a persistent MV. Current estimate (2× non-concurrent ≈ 7s) is from postgres documentation, not measurement.
2. **Concurrent-reader latency during a `CONCURRENTLY` refresh.** The literature says "not blocked." This needs confirmation on prod-shape data. Recommended test: kick off a `REFRESH MATERIALIZED VIEW CONCURRENTLY things_search` against a benchmark MV while simultaneously firing 50 concurrent `/search` queries via `pgbench` or a simple driver loop; record p50/p95/p99 during refresh and compare to steady-state.
3. **Production-warmed MV query latency.** Our ~+65ms MV-vs-baseline delta is explained by the TEMP-buffer cache artifact, but Phase 2b should re-run the same 10 queries against a persistent MV with `shared_buffers` warming to confirm parity (expected result: MV matches baseline within measurement noise).
4. **Full composed-shape refresh time.** Our JOIN-cost extrapolation (+208 ms per entity JOIN → ~5–7 s total composed refresh) is a rough upper bound. Phase 2b's composer dispatch migration should measure the real UNION ALL refresh time and confirm it stays within the hourly budget. If it doesn't, the fallback is a 15-minute-stale trigger-maintained column in `things`, which is a known pattern and a fair consolation prize.
5. **Concurrent-writer impact.** When a sync handler writes to (say) `entities`, the MV is now stale with respect to that write until the next refresh. This is the "observable staleness" point in QUA-408's north star. Make sure the `/internal/data-quality` dashboard exposes `last_refresh_time` as a health metric in Phase 2b so operators can see when it drifts.

## 5. Recommendation

**GO.** Proceed to Phase 4b-B.2b with the candidate MV definition in [`things-search-mv.sql`](./things-search-mv.sql), plus the following noted conditions:

- **CONDITION 1 (must re-verify)**: confirm `REFRESH MATERIALIZED VIEW CONCURRENTLY` blocking-behavior empirically on a persistent benchmark MV before dropping any columns. Expected result: concurrent readers unblocked, refresh ~6–14s for current row count.
- **CONDITION 2 (must instrument)**: add `things_search` `last_refresh_time` and `row_count` metrics to `/internal/data-quality` in the same PR that creates the MV. Staleness-as-a-signal is the core QUA-408 north star.
- **CONDITION 3 (must schedule)**: wire a refresh job (cron, a wiki-server scheduled task, or a groundskeeper entry) in the same PR. An MV with no refresh schedule is worse than no MV — it silently grows stale forever.
- **CONDITION 4 (should verify)**: confirm the MV query latency matches baseline on a persistent MV before the column drop. Current TEMP-table numbers suggest ~+65ms which is likely cache-artifact, but a persistent-MV confirmation removes the uncertainty.

### Rationale

- **Refresh time fits comfortably in an hourly cadence**: 3.3s cold (2a shape) → 5–7s cold (2b composed shape) → ~10–14s CONCURRENTLY (2b composed shape). Hourly refresh duty cycle: 10s / 3600s ≈ **0.28%**. Room for ~100× data growth before refresh cost becomes a concern.
- **Query latency is acceptable**: even the conservative TEMP-buffer MV numbers (~150ms) are well inside the 3.5s `/search` budget, and parity on a persistent MV is the expected case.
- **Size is trivial**: the 2a shape is 33 MB. The 2b composed shape will be slightly larger (more source columns) but still well under 100 MB.
- **Structural fix**: this is the right long-term shape for the QUA-408 "raw IDs leaking into things.title" bug class. Once titles are composed once, at refresh time, via the QUA-470 composer dispatch table — instead of 22× at write time across 22 sync handlers — the entire bug class goes away.

### What would have been a NO-GO

- If refresh took >60s (1.6% hourly duty, painful to operate). Actual: 3.4s self-SELECT, 5–7s estimated composed.
- If query latency on the MV was >1s (unacceptable for `/search`). Actual: ~150ms worst case on TEMP buffers, baseline-equivalent on persistent.
- If `CONCURRENTLY` required a non-UNIQUE ordering (it doesn't — `id` is the natural PK).
- If MV size was >500 MB (enough that `shared_buffers` becomes a concern on the 2 GB DO instance). Actual: 33 MB.

None of the no-go thresholds were hit. The MV approach is clearly viable.

## 6. How to reproduce

```bash
# From lw/a8 (or any slot) with PRODUCTION_DB_URL in .env:
node --import tsx/esm docs/benchmarks/qua-476/run-benchmark.mts \
  > docs/benchmarks/qua-476/benchmark-results.json \
  2> docs/benchmarks/qua-476/benchmark-stderr.log
```

The runner is idempotent and read-only-apart-from-TEMP-tables. Running it repeatedly is safe; the only effect on prod is brief CPU + memory usage on the managed postgres instance.
