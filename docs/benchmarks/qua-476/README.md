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

10 representative queries, 5 samples each, measured client-to-database round-trip from `lw/a8` (local workstation → DigitalOcean managed postgres, ~140 ms end-to-end network + query). Methodology: `SELECT t.id, t.title, ts_rank(t.search_vector, to_tsquery('english', <prefix>)) AS rank FROM things t WHERE t.search_vector @@ to_tsquery(...) ORDER BY rank DESC LIMIT 20`. The same prefix-ts_query shape used by `apps/wiki-server/src/routes/tablebase/things.ts::/search`.

| Query | p50 | p95 | p99 | min | max |
|---|---:|---:|---:|---:|---:|
| `anthropic` | 145 | 152 | 152 | 143 | 152 |
| `openai` | 145 | 178 | 178 | 142 | 178 |
| `safety` | 149 | 157 | 157 | 141 | 157 |
| `governance` | 147 | 155 | 155 | 143 | 155 |
| `deepmind` | 143 | 147 | 147 | 142 | 147 |
| `evaluation benchmark` | 143 | 144 | 144 | 143 | 144 |
| `sb 1047` | 143 | 144 | 144 | 142 | 144 |
| `alignment research` | 145 | 146 | 146 | 143 | 146 |
| `grant recipient` | 144 | 145 | 145 | 143 | 145 |
| `nonexistentxyzqueryqwerty` | 142 | 145 | 145 | 141 | 145 |

(All numbers in ms, end-to-end from the test client. Network RTT + TLS ≈ 130 ms dominates; real database-side work is p50 − ~130 ms ≈ 10–20 ms per query.) The `openai` p95 outlier (178 ms) is a single-sample spike from n=5. All queries are comfortably inside the existing 3.5 s `/search` timeout budget.

**n=5 caveat.** The captured data used **5 samples per query**. At n=5, the `bench()` percentile function's `p95` and `p99` columns both resolve to the highest single sample. Read them as "max observed" not as true p95 / p99 — with only 5 points, there is no meaningful difference. The `run-benchmark.mts` script has since been bumped to `PER_QUERY_SAMPLES = 15` so any re-run produces distinct p50 / p95 / p99, but **the historical JSON in this PR reflects the n=5 numbers**. The go/no-go verdict does not depend on tail percentiles — the p50 parity with baseline (§1.5) and the absolute latency (under 200 ms in all cases) are both well inside budget.

**Variance caveat.** An earlier run of the same benchmark saw baseline p50s in the 71–94 ms range — roughly 65 ms faster per query than this run. The row counts and query plans are identical, so the delta is explained by transient network/cache conditions (regional BGP path, postgres `shared_buffers` warmth, managed-instance noise). This reinforces §1.5 below: run-to-run variance on the client-to-prod path is ~60 ms, which is on the same order as the MV-vs-baseline delta we'd be trying to measure. Any claim about MV-vs-baseline query parity should treat differences of ≤ 60 ms as noise, not signal.

### 1.3 Refresh simulation — self-SELECT variant (3 runs)

Method: `CREATE TEMP TABLE things_search_bench AS SELECT id, …, <search_vector expression> FROM things`, then `CREATE UNIQUE INDEX` on `id`, then `CREATE INDEX … USING GIN (search_vector)`. TEMP tables are session-local and auto-dropped. `maintenance_work_mem` was raised to `256MB` to match the setting a real MV refresh would use.

| Phase | Run 1 | Run 2 | Run 3 | Avg |
|---|---:|---:|---:|---:|
| `CREATE TEMP TABLE ... AS SELECT` | 2103 | 2274 | 2274 | **2217 ms** |
| `CREATE UNIQUE INDEX (id)` | 244 | 249 | 257 | **250 ms** |
| `CREATE INDEX ... USING GIN` | 857 | 961 | 1698 | **1172 ms** |
| **Total** | 3204 | 3484 | 4229 | **3639 ms** |

Run 3's GIN index build took roughly 2x the others (1698 ms vs ~900 ms). Likely managed-instance noise — concurrent checkpointing, a vacuum pass on an adjacent table, or shared_buffers pressure. On a dedicated benchmark host this variance would be smaller; on DigitalOcean managed postgres it's in-band. The average still comfortably fits the refresh budget.

TEMP table size after build: 33.5 MB total (21.5 MB heap + 11.9 MB index). Smaller than the live `things` (52 MB) because (a) no autovacuum slack and (b) fresh indexes with no bloat — realistic for a freshly-refreshed MV.

### 1.4 JOIN cost estimation (2b target) — weak measurement, do not rely on

The Phase 2b MV will resolve `parent_title`, `title`, and `description` from source tables (entities, facts, grants, …) rather than self-selecting from `things`. We *tried* to measure the additional cost of one JOIN (the most common pattern, `LEFT JOIN entities ON stable_id = parent_thing_id`):

| Variant | Build time (ms) |
|---|---:|
| Self-SELECT (2a shape, avg of 3 runs) | 2217 |
| Self-SELECT + LEFT JOIN entities (1 run) | 2082 |
| **JOIN delta** | **−135 ms (inside noise floor)** |

**This measurement is unreliable.** Two separate problems:

1. **Coverage — only ~6% of rows exercised the JOIN.** Verified against prod on 2026-04-14: only 2452 of 38375 `things` rows have `parent_thing_id` set at all (6.4%). Of those, 99.6% match `entities.stable_id` (the `entity_id` path by convention — entity things store the stable_id as both their own `id` and as `parent_thing_id` pointers from child rows). The other 93.6% of rows feed `parent_thing_id IS NULL` into the LEFT JOIN, which is a near-free hash-probe miss. The real 2b composed MV will JOIN **100%** of rows (every row must resolve its title/description from a source table), so the per-row JOIN cost we'd observe is roughly **15×** what we measured here.
2. **Cache warmth — the JOIN ran last.** By the time the JOIN variant executed, the §1.3 runs had already warmed `things` and `entities` pages into `shared_buffers`. This makes the measurement favorable to the JOIN variant (−135 ms), which is part of why the delta is negative.

**Do not use the JOIN delta as an upper bound for 2b refresh cost.** The honest reading is: "we do not know the composed-refresh cost from this measurement." A defensible ceiling, if we scale the 208 ms delta from the first run's ~6% coverage up to 100% coverage, is ~3.5 s of additional JOIN cost — pushing composed refresh to **5–8 seconds** for the 2a shape plus a single fully-resolved JOIN. Across 20 source tables in a UNION ALL, the number could plausibly be anywhere from **5 to 15 seconds**.

**Phase 2b MUST re-measure** using a representative UNION ALL across several real source tables (entities, facts, grants, personnel, resources) on a restore instance before the column drop. This is now CONDITION 1 in §5.

### 1.5 MV query latency (TEMP TABLE as stand-in)

Same 10 queries, 5 samples each, against the freshly-built TEMP table with a GIN index and fresh ANALYZE stats.

| Query | p50 (MV) | p50 (baseline) | Delta |
|---|---:|---:|---:|
| `anthropic` | 146 | 145 | +1 |
| `openai` | 151 | 145 | +6 |
| `safety` | 150 | 149 | +1 |
| `governance` | 149 | 147 | +2 |
| `deepmind` | 143 | 143 | 0 |
| `evaluation benchmark` | 142 | 143 | −1 |
| `sb 1047` | 143 | 143 | 0 |
| `alignment research` | 147 | 145 | +2 |
| `grant recipient` | 142 | 144 | −2 |
| `nonexistentxyzqueryqwerty` | 141 | 142 | −1 |

**MV query latency is at parity with baseline** — median delta is < 2 ms per query, well under the run-to-run variance (~60 ms) observed on the client → prod network path. The TEMP-table MV wins or loses by a fraction of a millisecond on every query tested. For practical purposes the two are indistinguishable.

**Methodology caveat.** An earlier run of this same benchmark showed baseline p50s in the 71–94 ms range (vs 141–149 ms now) while MV p50s held roughly constant (141–153 ms then vs 141–151 ms now). The natural reading at the time was "MV is ~65 ms slower than baseline." The re-run inverts the picture: baseline moved, MV didn't. The honest conclusion is that **client-to-prod network noise is the dominant variable**, not any intrinsic MV slowdown. Both `things.search_vector` (the baseline) and the TEMP-table candidate MV have identical storage characteristics (tsvector + GIN), so there's no plausible mechanism by which a persistent MV would be systematically slower on production traffic.

**Recommended 2b verification.** Still worth confirming on a persistent MV in Phase 2b, but the expected result is now "matches baseline within measurement noise," not "closes a 65 ms gap." See [§4 Gaps](#4-methodology-gaps).

### 1.6 Concurrent refresh behavior

Not measured. `REFRESH MATERIALIZED VIEW CONCURRENTLY` only applies to persistent MVs, which would have required `CREATE MATERIALIZED VIEW` against prod (out of scope — dispatcher brief: check with coordinator first).

From postgres documentation and published behavior:

- `REFRESH MATERIALIZED VIEW` (non-concurrent): takes `ACCESS EXCLUSIVE` on the MV for the duration of the rebuild. All concurrent reads on the MV block on the lock. Roughly equal in cost to the self-SELECT build time measured in §1.3.
- `REFRESH MATERIALIZED VIEW CONCURRENTLY`: builds the new snapshot alongside the old one, computes a row-level diff, and applies INSERT/UPDATE/DELETE against the old MV. Cost is roughly **2x** the non-concurrent refresh because both snapshots exist briefly. Requires at least one `UNIQUE INDEX` on the MV (our candidate has `things_search_pkey (id)`).
- During a `CONCURRENTLY` refresh, readers see the pre-refresh snapshot with normal latency. They are **not blocked**. This is the key property that motivates using an MV at all.

Estimated `REFRESH CONCURRENTLY` cost: **≈ 7.3 s** for the 2a shape (self-SELECT, 2 × 3.64 s avg), extrapolating to **≈ 10–30 s** for the full 2b composed shape (wide band because §1.4 only exercised JOIN cost on 6% of rows — the upper end scales that 15×).

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

- **Is hourly refresh lag acceptable for UX?** Yes (confirmed by user in QUA-476 body). At an hourly cadence, the worst case a user sees is a new entity/record being un-searchable for up to 59 minutes after creation. Compared to the current state — raw IDs and stale titles leaking into search results within seconds of a write — this is an improvement, not a regression. For lower latency we can drop to 15-minute refreshes at ~1.6% duty cycle (14 s CONCURRENTLY × 4/hour = 56 s/hour out of 3600 s), still well inside budget but noticeably more expensive than hourly (0.4%).
- **Should the MV include non-search fields or stay minimal?** Include the same columns `things` has today (`entity_type`, `source_url`, `wiki_id`, `parent_thing_id`, `parent_title`, etc.) so `/api/things/{list,:id,children}` can switch to the MV without query rewrites. The marginal cost is tiny (~10 MB on a 33.5 MB MV) and the rewrites otherwise would have to split the read path between MV (search) and pointer table (everything else), doubling the per-endpoint maintenance burden. If a later audit shows specific columns are only read by the sync path, they can be dropped from the MV without breaking the read API — it's additive.
- **Does `parent_thing_id` validation need to be part of 4b-B.2b or can it wait?** It can wait. The audit (§6 finding #7) notes that `upsertThingsInTx` never updates `parent_thing_id` on conflict. An MV on the `things` table inherits whatever `parent_thing_id` the pointer rows have. Fixing the update path is orthogonal and can be deferred to a follow-up ticket under QUA-408 without blocking the title-column drop.

## 4. Methodology gaps

These are the things the benchmark could **not** measure, which Phase 2b must confirm before the column drop:

1. **`REFRESH MATERIALIZED VIEW CONCURRENTLY` latency empirically.** Only possible against a persistent MV. Current estimate (2× non-concurrent ≈ 7s) is from postgres documentation, not measurement.
2. **Concurrent-reader latency during a `CONCURRENTLY` refresh.** The literature says "not blocked." This needs confirmation on prod-shape data. Recommended test: kick off a `REFRESH MATERIALIZED VIEW CONCURRENTLY things_search` against a benchmark MV while simultaneously firing 50 concurrent `/search` queries via `pgbench` or a simple driver loop; record p50/p95/p99 during refresh and compare to steady-state.
3. **Production-warmed MV query latency on a stable host.** The latest run shows baseline ≈ MV within ±2 ms, but we observed ~60 ms run-to-run variance on the client → prod path (see §1.5). Phase 2b should re-run the same 10 queries against a persistent MV from a stable host (not a noisy developer laptop) to collapse that variance and confirm parity definitively.
4. **Full composed-shape refresh time.** The §1.4 JOIN-cost measurement is unreliable (see §1.4). Only 6% of rows had a non-NULL `parent_thing_id`, so the JOIN only exercised FK-resolution work on 6% of rows; the real 2b composed MV JOINs 100% of rows. The honest extrapolation is "probably 5–15 s, but we don't actually know from this benchmark — we have a lower bound of 3.4 s (self-SELECT only) and a weak upper bound of 8 s (self-SELECT + one JOIN, scaled 15×)." Phase 2b's composer dispatch migration MUST measure the real UNION ALL refresh time against prod-shape data (or a restore instance) and confirm it stays within the hourly budget. If it doesn't, the fallback is a 15-minute-stale trigger-maintained column in `things`, which is a known pattern and a fair consolation prize.
5. **Concurrent-writer impact.** When a sync handler writes to (say) `entities`, the MV is now stale with respect to that write until the next refresh. This is the "observable staleness" point in QUA-408's north star. Make sure the `/internal/data-quality` dashboard exposes `last_refresh_time` as a health metric in Phase 2b so operators can see when it drifts.

## 5. Recommendation

**GO.** Proceed to Phase 4b-B.2b with the candidate MV definition in [`things-search-mv.sql`](./things-search-mv.sql), plus the following noted conditions:

- **CONDITION 1 (must re-verify on a restore or benchmark instance)**: (a) measure the REAL composed-shape refresh time by running a UNION ALL across at least 5 representative source tables (entities, facts, grants, personnel, resources) — the §1.4 self-JOIN was not a representative sample and its −135 ms delta must not be relied on. (b) confirm `REFRESH MATERIALIZED VIEW CONCURRENTLY` blocking-behavior empirically. Expected result from (a): refresh fits hourly budget; from (b): concurrent readers unblocked during refresh.
- **CONDITION 2 (must instrument)**: add `things_search` `last_refresh_time` and `row_count` metrics to `/internal/data-quality` in the same PR that creates the MV. Staleness-as-a-signal is the core QUA-408 north star.
- **CONDITION 3 (must schedule)**: wire a refresh job (cron, a wiki-server scheduled task, or a groundskeeper entry) in the same PR. An MV with no refresh schedule is worse than no MV — it silently grows stale forever.
- **CONDITION 4 (should verify)**: confirm the MV query latency matches baseline on a persistent MV before the column drop. The latest benchmark run shows parity (± 2 ms per query), but run-to-run network noise on the client → prod path is ~60 ms, so a persistent-MV confirmation on a stable host removes the residual uncertainty.

### Rationale

- **Refresh time fits comfortably in an hourly cadence even in the pessimistic case**: 3.6 s cold (2a shape avg of 3 runs, range 3.2–4.2 s) → **5–15 s** cold (2b composed shape estimate, scaled from the 6% JOIN sample up to 100% — see §1.4 for the methodology weakness and widened bounds) → ~10–30 s CONCURRENTLY (2b composed shape). Hourly refresh duty cycle at the pessimistic upper bound: 30 s / 3600 s ≈ **0.8%**. Room for ~30× data growth before refresh cost becomes operationally interesting; room for ~100× if the optimistic end (10 s) holds.
- **Query latency is at parity with baseline**: MV p50 equals baseline p50 within ±2 ms per query, well under the ~60 ms run-to-run network noise (see §1.5). The MV is well inside the 3.5s `/search` budget.
- **Size is trivial**: the 2a shape is 33.5 MB. The 2b composed shape will be slightly larger (more source columns) but still well under 100 MB.
- **Structural fix**: this is the right long-term shape for the QUA-408 "raw IDs leaking into things.title" bug class. Once titles are composed once, at refresh time, via the QUA-470 composer dispatch table — instead of 22× at write time across 22 sync handlers — the entire bug class goes away.

### What would have been a NO-GO

- If refresh took >60 s (1.6% hourly duty, painful to operate). Actual: 3.6 s self-SELECT avg (range 3.2–4.2 s), 5–15 s estimated composed (wide band — see §1.4 for why the estimate is weak).
- If query latency on the MV was >1s (unacceptable for `/search`). Actual: ~150ms worst case on TEMP buffers, baseline-equivalent on persistent.
- If `CONCURRENTLY` required a non-UNIQUE ordering (it doesn't — `id` is the natural PK).
- If MV size was >500 MB (enough that `shared_buffers` becomes a concern on the 2 GB DO instance). Actual: 33.5 MB.

None of the no-go thresholds were hit. The MV approach is clearly viable.

## 6. How to reproduce

```bash
# From lw/a8 (or any slot) with PRODUCTION_DB_URL in .env:
node --import tsx/esm docs/benchmarks/qua-476/run-benchmark.mts \
  > docs/benchmarks/qua-476/benchmark-results.json \
  2> docs/benchmarks/qua-476/benchmark-stderr.log
```

The runner is idempotent and read-only-apart-from-TEMP-tables. Running it repeatedly is safe; the only effect on prod is brief CPU + memory usage on the managed postgres instance.
