# Low-risk cleanup plan (2026-09)

**Status:** proposed. Every change below is already written as a patch in
`patches/`. Each patch was checked on HEAD `e35e704fa`, and all 14 were
checked applied together.
**Owner time needed:** about 15 minutes of clicking in GitHub, plus five
yes/no answers (Tier 2). Everything else merges when CI is green.

## Why

The repo has been idle since 2026-06-25, but its automation has not
(numbers measured 2026-09-26):

- `AUTOMATION_PAUSED` is `false`. About 20 cron workflows still run against
  the frozen `main`. Five of them spend LLM money: sourcing,
  scheduled-maintenance, sourcing-recheck, flagship-curate and
  improve-pipeline-baseline.
- `sourcing.yml` has failed 5 of its last 5 runs. It pays for batch 1 (500
  requests), then crashes with `All customId values must be unique within
  a batch`.
- `ci-pr-health.yml` fails twice a day because `ci.yml` has not run in 7
  days. Each failure reopens QUA-1183.
- **Security:** `/api/framework-review-proxy` on the public site forwards
  **anonymous POSTs to the production wiki-server using the server API
  key**. A GET without credentials returns live data.
- **Security:** the wiki-server skips auth when its API key is unset.
- **Correctness:** `build-data.mjs` writes four kinds of derived data to the
  wiki-server from **pull-request CI** (and from local feature-branch
  builds). Nothing checks which branch is being built.

The same review found about 20k lines of code that nothing uses. It also
found about 17–22k tokens of agent instructions that load into every
session, many of which only matter for a 20-slot agent fleet.

## What counts as low risk here

Each change must meet all of these:

1. No database DDL, and no change to what production data is written
   (apart from stopping writes that should never have happened).
2. No change public readers can see. The one exception is three redirects
   that keep the same status codes.
3. A deletion is allowed only when a repo-wide reference check shows no
   callers, and CI (typecheck + tests) would catch a mistake.
4. Rollback is a single `git revert`.

Anything that fails a test goes to Tier 3 and waits for the owner.

## Tier 0: GitHub UI only (≈10 min, owner)

- Merge Dependabot **#4985**, hono 4.12.26 → 4.13.5. It has three
  security fixes and is mergeable. Then merge the other green
  minor/patch bumps: #4986, #4987, #4988, #4982, #4973.
- Close the 8 stale `[maintenance]` PRs from claude[bot] (#4961–#4981,
  Jun 22–Aug 2).
- Optional: prune about 140 stale `claude/*` branches.

## Tier 1: merge when green (no decision needed)

| PR | Patches | Change | Size | Rollback / manual step |
|---|---|---|---|---|
| A. Security | `sec-1`, `sec-2`, `sec-3` | (1) The framework-review proxy refuses POST with 403 unless `LONGTERMWIKI_ADMIN_WRITE_TOKEN` is set and matches a header or cookie, and the request is JSON. GETs are unchanged. (2) wiki-server with no key and `NODE_ENV=production`: reads work, writes get 503, and an error is logged. Dev and tests are unchanged. The server never refuses to boot, so the smoke test in `wiki-server-docker.yml` (which runs with no key) still passes. Also fixes the rate limiter trusting any bearer token when no key is set. (3) `shouldWriteToServer()` blocks the four build-data writes on `pull_request` and `merge_group` events, and on non-local servers from dev machines. Pushes to main and production, schedules on main, and Vercel production keep writing. `BUILD_DATA_SERVER_WRITES=1/0` overrides. | +524 / −15, with 20 new tests | Revert. Web-based framework review stays off until you set the token (0 versions are pending today). |
| B. Stop idle crons | `ci-1` | Comment out the `schedule:` block in 9 workflows: sourcing, sourcing-recheck, flagship-curate, scheduled-maintenance, improve-pipeline-baseline (LLM spend), plus ci-pr-health, job-worker, auto-merge-backfill, auto-rebase (noise or idle runner time). `workflow_dispatch` still works. Backups, export, snapshots, health monitors and the dead-man switch **stay on**. | +39 / −21 | Uncomment. The only check that watches these schedules (`crux health --check=actions`) runs inside ci-pr-health, so no other alarm fires. |
| C. Web dead code | `web-batch-1`, `web-batch-3` | Remove 32 MDX stub components that nothing uses. All 784 content files were parsed with remark-mdx to confirm none renders them. Remove 9 web files with no importers (e.g. `FactDashboard.tsx`, 955 lines). Move 3 redirect-only pages into `next.config` redirects with the same 307/308 codes. | −2.2k | Revert. |
| D. Crux orphans + finished migrations | `crux-batch-1`, `crux-batch-2` | 23 modules with no importers. 25 one-shot migration or backfill scripts whose migrations have already landed. `sync-careers-to-personnel` is already broken: its input file doesn't exist. | −11.0k | Revert, or `git show e35e704fa:<path>`. |
| E. Crux finished commands + orphan data | `crux-batch-3`, `web-batch-2` | Remove migration commands that are registered but finished (`backfill-*-stable-ids`, `factbase-migrate*`, `migrate-citations`, `strip-scores`) and the deprecated `kb` alias. Delete 2 Phase-3 prototype scripts, 2 unused data files and a stray marker file. Archive `.claude/plans`, `apps/web/.claude/plans` and `todo/` to `docs/archive/`. | −3.4k | Revert. |
| F. Crux type errors | `tsc-1` | Delete `crux-tsc-baseline.txt`, which nothing has read since QUA-524. Fix 16 of the 17 real crux type errors with type-only changes. | +30 / −17 | Revert. |

**Order:** A first, since it is the security fix. B next, since it stops spend. C–F in any order,
with one constraint: `crux-batch-4` (Tier 2) must go after `crux-batch-3`.

## Tier 2: one yes/no each

| # | Patch | Question | Default if no answer |
|---|---|---|---|
| 1 | `web-batch-4` | Delete `/api/integrity` and `/api/operations-log`? No caller exists anywhere in the repo. Could anyone outside the repo call them by hand? (−302 lines) | Don't merge |
| 2 | `crux-batch-4` | Delete `backfill-grantee-ids`, `backfill-program-ids`, `backfill-pr-outcomes`, `import-quri-personnel`, `crux/calibration/`, and 2 unused wiki-server clients? Do you run any of these by hand? (−2.9k lines) | Don't merge |
| 3 | `ctx-1` | Slim the context that loads into every agent session. `CLAUDE.md` goes from 2,765 to 840 words, and the 11 rule files become on-demand docs (≈17–22k → ≈1.5k tokens). 14 hooks move to an opt-in `.claude/settings.fleet.json`, e.g. require-checklist, heartbeat and block-branch-switch. Turn them back on with `cp .claude/settings.fleet.json .claude/settings.local.json`. No scripts are deleted. What you lose: the `stage:approved` merge gate, automatic Linear/session logging, and the slot-isolation hooks. | Don't merge |
| 4 | none | The last crux type error is a real bug. `ENTITY_REF_FK_MAP` in `crux/commands/tb-importers/propose-client.ts` has no entry for `publication`, so semantic-scholar/openalex/crossref proposals that set `entityRefs` throw "is not iterable". Should the person reference map to an author column, or be dropped the way the T2 client does? After that fix, `typecheck-crux` can become blocking. | Leave it |
| 5 | none | Fix `sourcing.yml`'s duplicate `customId` bug before turning it back on, or retire weekly sourcing? | Leave it off (PR B) |

## Tier 3: out of scope (needs design or owner attention)

These came out of the same review. They are deliberately **not** in this
plan:

- **Where facts are authoritative.** `build-data.mjs:681` says YAML is
  primary, yet line ~710 prefers PG facts. The missing-sources pipeline
  writes to both. Recommended: make YAML authoritative for facts and
  stakeholders, and delete the PG override. This is a policy decision.
- **Operator data readable by the public.** Each `/internal/*` page
  redirects to a public `/wiki/E<n>` page (e.g. E1281 shows agent
  sessions, E1011 shows PRs). Also `/api/agent-session-events`, and
  anonymous `/api/client-errors` inserts.
- **Dropping dead schema.** The 7 `_archived_*` tables, `properties` and
  `operations_log`. Needs production row counts first.
- **Consolidations.** V1/V2 authoring engines; 6 source-checking
  implementations; `things` as a view; the 23 `@wiki-server/*` tsconfig
  aliases.
- **Agent-fleet code.** pr-patrol, slots/dispatch, sessions and similar,
  about 45–60k lines. This depends on whether the parallel-agent fleet
  comes back.
- **Other items.** 11 stale internal dashboards, discord-bot, and the stale
  architecture docs (`data-system-authority.mdx` and 4 others describe
  `packages/kb` and `data/facts`, which no longer exist).

## How the patches were checked

All 14 patches applied in the order
`sec-1..3, web-1, web-3, web-2, web-4, crux-1..4, tsc-1, ctx-1`, with
`ci-1` checked separately. Wiki-server env vars were unset throughout.

| Check | Result |
|---|---|
| `apps/web` `tsc --noEmit` | 0 errors |
| `apps/wiki-server` `tsc --noEmit` | 0 errors |
| crux typecheck (the gate's `typecheck-crux` step) | 17 → 1 errors (the Tier 2 #4 bug) |
| web vitest | all pass once build-data output exists (2 tests need a generated `database.json`; they also fail on HEAD without it) |
| wiki-server vitest | 1725 passed, 57 skipped |
| crux vitest | 9857 passed. The 3 timeouts seen on HEAD did not recur; they look timing-dependent, not fixed. Two failures found only by applying the patches together were fixed in these patches: a `source-check` wording ratchet hit, and a content-scope log line. |
| `node crux/build.mjs`, `pnpm crux --help` | OK |
| `pnpm crux w validate gate --scope=content` | 3/3 pass |
| eslint on changed files | clean |
| `build-data.mjs` with no server, and a simulated PR run | exit 0, 782 pages. The PR run logs "writes disabled (GitHub Actions pull_request event)". |

A full `next build` was not run offline. The MDX stub removal was
instead checked by parsing every content file.

## Applying a patch

```bash
git checkout -b cleanup/<name> origin/main
git apply --index docs/plans/2026-09-low-risk-cleanup/patches/<patch>.patch
git commit -m "<title>"   # then open a PR; CI + merge queue are the gate
```

Delete this directory once everything has landed.
