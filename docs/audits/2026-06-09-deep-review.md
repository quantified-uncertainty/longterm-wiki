# Deep Codebase Review — longterm-wiki

*2026-06-09. Six parallel review agents over `main/` (current HEAD 4ed3c99ae), each anchored to Linear direction (QUA-408 et al.) and internal docs/ADRs. New findings filed as QUA-1153–1160; cross-reference comments added to QUA-130 and QUA-1144.*

Companions: [`../plans/refactor-portfolio-2026-06.md`](../plans/refactor-portfolio-2026-06.md) (large-refactor plans), [`./2026-06-09-deletion-catalog.md`](./2026-06-09-deletion-catalog.md) (verified delete lists).

## Live incident found (releases session)

**QUA-1153 (P1)**: wiki-server returning HTTP 401 to CI's `LONGTERMWIKI_SERVER_API_KEY` since ~June 8. `job-worker.yml` failing every 30 min (~48 red runs/day); 7 scheduled workflows red since Jun 7–8 (server-api-health, frontend-data-health, data-validation, snapshot-resources, wiki-server-export, sync-entities-facts). Because `build-data` is fail-closed in CI (QUA-772), **the next PR or main push fails CI at build-data**. Main CI last green Jun 4. Fix is secret/ops-side; follow-up: `_preflight-wiki-server.yml` checks reachability but not auth — add an authenticated probe.

## The meta-finding

The documented direction (QUA-408 + ADRs) is good and partially executed — `things.title/description` denorm was dropped (migration 0204), composition moved to the `things_search` MV, 40/46 sync endpoints run through one factory. But:

1. **Every load-bearing ADR is stuck in `Charter` past its time-box** (0001 crux, 0002 three-bases, 0006 wiki-server decomposition) while code drifts: crux grew 35% (→418K LOC) since its ADR; route surface grew 122→~566 endpoints; dashboard layer doubled past ADR-0008's numbers.
2. **QUA-408's own fix reproduced the disease it diagnosed**: 7 thing types added since April dual-write to `things` but have no MV branch — unsearchable, `/things/:id` 404s forever, error message points to a refresh that will never include them (QUA-1154; plausibly the root cause of QUA-1144). No drift guard; the thing-type registry lives in 4+ places.
3. **Silent-failure is the house style in the most dangerous places**: entity prune can delete prod rows after a partially-failed YAML load, uncapped (QUA-1155); facts.ts sync silently nulls unresolved FKs and returns 200 (QUA-1160); groundskeeper's `payload`-vs-`params` mismatch is silently stripped by Zod → backfill-sources runs at a $100 cost cap instead of $5 (QUA-1157); ~597 bare `catch {` blocks in crux vs 18 `// catch-ok` annotations.

## Tickets filed

| Ticket | Finding |
|---|---|
| [QUA-1153](https://linear.app/quantifieduncertainty/issue/QUA-1153) (P1) | Live 401 — CI automation down since Jun 8 |
| [QUA-1154](https://linear.app/quantifieduncertainty/issue/QUA-1154) | `things_search` MV missing 7 live thing types; no drift guard; error message points at wrong endpoint path |
| [QUA-1155](https://linear.app/quantifieduncertainty/issue/QUA-1155) | YAML→PG prune = data-loss mechanism (partial parse → uncapped delete; empty keepIds deletes all of a type) |
| [QUA-1156](https://linear.app/quantifieduncertainty/issue/QUA-1156) | Auth AND rate-limiting fail open when `LONGTERMWIKI_SERVER_API_KEY` unset (auth.ts:36-40, rate-limit.ts:336-340); no startup assertion; 47 DELETE handlers + 40 batch-delete endpoints world-writable on a dropped secret |
| [QUA-1157](https://linear.app/quantifieduncertainty/issue/QUA-1157) | `payload`/`params` contract bug → 20× cost-cap inversion; no typed job-name registry anywhere (generalizes QUA-1134) |
| [QUA-1158](https://linear.app/quantifieduncertainty/issue/QUA-1158) | Wellness ticket storm is structural: 7 single-check `--auto-issue` runs share one issue title; any passing check closes a failing check's issue; LINEAR_API_KEY missing from Actions secrets so dedup is dormant |
| [QUA-1159](https://linear.app/quantifieduncertainty/issue/QUA-1159) | `packages/factbase` (the authoritative facts loader) + groundskeeper test suites — 25 files — executed by nothing (not CI, not root `pnpm test`) |
| [QUA-1160](https://linear.app/quantifieduncertainty/issue/QUA-1160) | facts.ts:530-544 silently nulls unresolved subject FKs, returns success |

Confirmed-and-broadened on existing tickets: **QUA-130** live on 8 tables (sync-factory defaults conflictTarget to `table.id` while natural-key unique indexes exist with no override on personnel, division_personnel, entity_assessments, political_scores, campaign_finance, political_votes, model_system_cards, scorecard_grades — re-sync with regenerated ids → 23505 → whole batch rolls back; template fix is policy-stakeholders.ts:96-118). **QUA-636** worse than stated — the "separate baseline check" the gate comment cites does not exist (`crux-tsc-baseline.txt` is dead data). **QUA-1148** understated — ~35–40 blocking checks exist only in the bypassable local pre-push gate (including the two validators encoding actual 12-hour prod-stall incidents: fk-swap-double-drop, migration-large-table-ddl); `--no-verify` is normalized practice.

## Per-area results

### Data model / DB (vs QUA-408)
- The "20 sync handlers reimplementing title resolution" claim in the epic is **stale** — composition lives in the MV now; the un-unwound sibling is the **31 `*_display_name` write-time cache columns** (no staleness mechanism; QUA-764 sid-leak was the proof of harm; render-layer sanitize-raw-ids.ts is a 117-line workaround).
- ID-format sprawl: facts side closed properly (CHECK in 0198); resources side half-closed (`stable_id` NOT NULL but no format CHECK; 38 `isAnySid()` call sites, 33 prefix conditionals, 115 files referencing legacy formats; 5 formats tracked by the data-quality classifier).
- `record_type` keyspace: no CHECK, two naming conventions (singular-hyphenated vs plural table names) connected only by a regex `regexp_replace(...'s$','')` hack with hand-maintained irregular plurals (QUA-425 confirmed).
- Migration hygiene: 0184 was a `SELECT 1` placeholder for an out-of-band prod change; journal gap at 0208; every MV change re-emits ~600 lines by hand (the proximate cause of the MV drift).
- Good: sync-factory (40/46), build-data fail-closed (QUA-772), generated db-schema-reference with gate check (#4939), validate-things-denorm-dead tombstone.

### Wiki-server (vs ADR-0006)
- De-facto drifted toward "modulated monolith" but only the cheap parts: routes grouped by domain, mount registry with drift test, sync factory. Not done: schema split, import boundaries (sync-factory imports sourcing+claims+things — TableBase and sourcing are fused).
- Security: SQL injection clean (all raw SQL parameterized or developer-controlled); single shared API key = zero authz granularity (every slot, Vercel, CI share one identity; audit headers are self-reported); `/internal/*` frontend has no auth (noindex only); error responses include full PG cause chains (fine under single-key trust, a leak the day key tiers land).
- Concurrency: good — FOR UPDATE SKIP LOCKED job claims, atomic retry increments, SET LOCAL audit context. Gaps — evidence-upsert TOCTOU retried via string-sniffed error matching (sourcing.ts:1011-1056, two copies); agent-sessions branch dedup has no partial unique index; `/sweep` bypasses validation (QUA-475); no advisory lock on MV refreshes.
- Silent-failure census: 118 catch blocks in routes/, 36 swallow (19 log-and-continue, 10 no logging at all, 7 comment-justified). Worst: facts FK-nulling; missing-sources `safeQuery` returning `{total: 0}` on error (false all-clear on a data-quality dashboard); scanner-results chunked upserts not in a transaction (the adjacent `/run` comments on exactly this hazard).
- QUA-593 confirmed (wide SELECTs pulling kilobyte JSON columns on list endpoints); QUA-54 confirmed (claimIds `.optional()` on all 5 claim-supporting sync schemas).

### Frontend (vs ADR-0008)
- QUA-398 mechanism found: `wiki/[id]/page.tsx:355` awaits a *global* 200-row verdict fetch per page render (also truncation bug past 200 verdicts); `next: { revalidate: 300 }` silently converts SSG to 5-min ISR; 51 files make runtime wiki-server fetches in server render paths; races/[id] is force-dynamic.
- QUA-1104 (hydration #418): org pages serialize ~15 eager tabs into one RSC flight payload — QUA-1052's per-collection cap reduced, not eliminated, the chunk race; 4 live now-dependent render sites in client components (data-sources relativeTime, search-client, SourcingDot toLocaleDateString); `formatDateDeterministic` helper exists, nothing enforces it (~170 toLocale* call sites).
- Dashboards: 34 (ADR says 32), 22.4K LOC (ADR says ~10K), 33/34 on Pattern A; the one violation exists because Pattern A structurally can't receive searchParams (undocumented limitation).
- Duplication (jscpd): 174 exact clones / 3,301 lines; four table stacks; largest single clone 94 lines.
- A11y split verdict: directory SortHeader is good (scope/aria-sort); the shared `ui/data-table.tsx` (33 consumers) has neither — highest-leverage single fix.
- 17→30 legacy MDX stub registrations dead (see deletion catalog); FactDashboard.tsx (954 LOC) unimported.

### CI / testing / gate (vs QUA-179, ADR-0003)
- CI/gate split-brain matrix: CI blocks unified/schema/refs, 4 app typechecks, 4 vitest suites, 2 migration validators, build, migrate-test (empty DB). NOT in CI: eslint (QUA-1148 confirmed — zero workflows run it), crux typecheck (QUA-636 — nothing enforces it anywhere), ~35 standalone validators (only inside a `continue-on-error: true` advisory step).
- Orphaned suites: packages/factbase (14 test files), groundskeeper (11) — never executed by anything (QUA-1159).
- e2e-post-deploy: zero retries, wait-loop checks reachability not deploy-version, no alerting on failure (6-run red streak just sat there); render-audit converts non-200s into skips.
- Gate escape hatches compound: `--no-verify` normalized + hook auto-allows pushes when main CI is red + stamp cache.
- Cost: build-data runs ~3× per PR push; the 13-min advisory full-gate step's warnings are read by nobody; coderabbit-security-gate is keyword-grep with high false positives.
- QUA-1141 partially stale (validate-workspace-dep-coverage already covers Dockerfile.worker COPY for file: deps — verify scope before dispatch).

### Background jobs / automation (vs QUA-167)
- Five overlapping mechanisms; **two competing queue consumers** (k8s daemon typed/3h-capable vs GHA cron any-type/60-min-kill that can murder long LLM jobs mid-spend then retry).
- QUA-1134 still live on main at review time + the broader `payload`→`params` strip (QUA-1157). The only existing guard (`types-guard.ts`) protects worker config, not enqueuers; groundskeeper bypasses the crux jobs client entirely.
- Groundskeeper: no missed-tick detection (QUA-535); enqueue tasks report success when the POST succeeds, not when the job runs (how QUA-1134 "succeeded" daily through 44 failures); the job-worker-health monitor trips its own circuit breaker on persistent true alarms; wellness check hard-codes `EXCLUDED_JOB_TYPES = {'auto-update'}` masking the failures.
- QUA-14: scheduled-maintenance runs claude-code-action at 80 turns/60 min with no dollar cap (~7 runs/week); `costUsd` recorded but never enforced.
- QUA-128 confirmed: `/evaluations/recompute-scores` exists, zero callers.
- Phase-1 "what runs where" landscape page is a hand-maintained TSX array, already drifted.

## Recommended priority order (from the review)

1. Fix the 401 (today, releases session) — QUA-1153
2. CI blocking additions: eslint + the two migration validators + the two orphaned test suites (one small PR — closes QUA-1148 and most of the split-brain)
3. Auth fail-closed startup assertion (QUA-1156)
4. Typed job contract + payload fix (QUA-1157)
5. Prune safety (QUA-1155)
6. crux-tsc ratchet (QUA-636)
7. MV closeout + drift guard (QUA-1154)
8. Wellness consolidation + LINEAR_API_KEY secret (QUA-1158)
9. Gate-in-CI restructure; then e2e-post-deploy hardening

## Documentation observations

The review leaned on `docs/adrs/`, `docs/plans/`, and `content/docs/internal/` throughout. Recurring problem: docs asserting things the code no longer does — root CLAUDE.md's "content pages make zero runtime API calls" is false; automation-landscape is a hand-maintained array that drifted; ADR-0008's size figures are 2× stale; QUA-1150 tracks 88 stale path refs across 12 files. The generation-from-source pattern (#4939, db-schema-reference) is the right template to extend. The three Charter ADRs are the most decision-relevant docs and the ones awaiting an owner.
