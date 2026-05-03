# Session Handover — Source-Check Backfill

## Goal

Ozzie's ask: "ensure we actually have source-checks that are valid."
1. Source-check backfill on all items without source-checks.
2. Triage failures — find new resources / fix data so everything is green.

## Current branch

`claude/resource-pipeline-triage` — WIP pushed. No PR opened yet.

## State as of 2026-04-14

### Step 1: Fill in missing source URLs — IMPLEMENTED, BLOCKED ON EXA KEY

**What exists (committed & pushed):**
- **Wiki-server endpoint**: `GET /api/sourcing/missing-sources` at `apps/wiki-server/src/routes/sourcing/missing-sources.ts`. Queries 10 tables (facts, personnel, investments, policy_stakeholders, equity_positions, divisions, funding_rounds, funding_programs, publications, page_citations) for rows where `source IS NULL`, groups by table, JOINs to entities for human-readable names, filters metadata facts (measure in website/description/logo/image).
- **Crux command**: `crux tb backfill-sources` at `crux/commands/backfill-sources.ts`. For each record: extract match terms, build search query, call `runResearch()` (fires Perplexity + Exa + SCRY in parallel, merges URLs, fetches content, falls back to Playwright for JS sites), check if all match terms appear in fetched content, update via sync API (facts → `/api/facts/sync`, others → table-registry).
- **Tests**: `apps/wiki-server/src/__tests__/missing-sources.test.ts` (5 tests) + `crux/commands/backfill-sources.test.ts` (14 tests). All green.
- **Verified end-to-end**: ran `--dry-run --limit=3` against local wiki-server + imported prod data. 18 records processed, 3 matches found (1 false positive from Kaseya helpdesk). Cost $0.005/record via Perplexity.

**Counts from the endpoint against local-imported prod data:**
- facts: 340 (metadata facts already filtered out — original was 759)
- page_citations: 493
- policy_stakeholders: 139
- investments: 47
- personnel: 18
- equity_positions: 13
- **Total: 1,050**

**Blocked on:**
- `EXA_API_KEY` — not in `.env`, not in k8s secrets, not in any sibling repo. Exa is the primary search engine; Perplexity alone gives low match rates.
- SCRY returning Cloudflare 403s from `api.exopriors.com`. SCRY searches EA Forum + LessWrong posts — high-value for AI safety entities.

**Usage (once EXA key arrives):**
```bash
pnpm crux tb backfill-sources --dry-run --limit=20                 # preview
pnpm crux tb backfill-sources --apply --limit=50                   # apply updates
pnpm crux tb backfill-sources --apply --table=facts --limit=100    # one table
```

### Step 2: Run verdict orchestrator — NOT STARTED

~7,000 rows have source URLs but no verdict. Run `pnpm crux tb verify-orchestrate --limit=2000` to fill them in. `ANTHROPIC_API_KEY` is in `.env` so this should work.

### Step 3: Triage non-green verdicts — NOT STARTED

After Step 2, fix contradicted/unverifiable/partial verdicts. Issue #4151 (formatValue rounding false positives) fixes ~16 of 47 contradicted facts mechanically.

### UI fix — DONE

SourcingDot removed from market data tables (secondary prices + prediction markets) at `apps/web/src/app/organizations/[slug]/market-data-section.tsx`. Committed.

## Session workflow

### Session start

1. Read this handover doc.
2. Check what's new since last session: Ozzie's commits, new PRs, issues.
3. Branch has uncommitted local changes to `.gitignore` and `.claude/` files — leave those alone.
4. Run `pnpm crux sys agent-checklist init --no-sync` before writing code. The working tree has untracked `.claude/` files; `--no-sync` skips the clean-tree check.

### SQL queries

Write SQL to `dev/sql/*.sql` files, pipe via stdin. Don't inline SQL in bash.
```bash
cat dev/sql/my-query.sql | ./dev/dev-env.sh psql-prod
```
The `psql-prod` function uses `docker compose exec -T` so piped stdin works. Existing queries in `dev/sql/` are gitignored (kept local for diagnostics).

### Running commands on prod vs local

- **Prod wiki-server**: prefix `WIKI_SERVER_ENV=prod` for any crux command hitting the API. Prod responds on `/api/source-checks/*` (legacy path). The new `/api/sourcing/missing-sources` endpoint is NOT deployed yet — only in our branch.
- **Prod DB** read-only queries: `./dev/dev-env.sh psql-prod -c "..."` or pipe a file.
- **Local dev**: `./dev/dev-env.sh start` spins up tmux session `lw-dev` with Postgres on :5432, wiki-server on :3100, Next.js on :3001, work window. `./dev/dev-env.sh import-prod` downloads latest prod backup and imports. Wiki-server migrations fail on imported prod data (CHECK constraints conflict) but server starts in DEGRADED mode — API still works.

### Testing the new endpoint locally

Once dev-env is up and prod data is imported:
```bash
curl -s "http://localhost:3100/api/sourcing/missing-sources?limit=5&table=facts" | python3 -m json.tool
```

### Long-running commands in tmux

Use `tmux send-keys -t right '...' Enter` for commands that shouldn't block the Claude session. The right pane is the user's shell.

## Key system knowledge

- **Architecture**: crux CLI never touches the DB directly. All data access goes through wiki-server HTTP API. The DB is only reachable via `./dev/dev-env.sh psql-prod` (direct psql through docker). See `.claude/rules/` for enforcement.
- **`fb source-check`** only checks `facts` table. **`tb verify-orchestrate`** checks all tables (superset). The existing `crux tb source-discover` command handles a different use case: finds *better* sources for records that already have a source but got an unverifiable verdict. Personnel-only, string-matches person names.
- **Source URLs** live on each table's `source` column (or `url` for `page_citations` and `publications`).
- **`source_check_verdicts`** table holds all verdicts. `record_type` + `record_id` point back to the source table.
- **12,413 rows** have verdicts. ~3,000 don't. Of the 3k: ~1,050 have no source URL (Step 1 target), ~2k have URLs but were never checked (Step 2 target).
- **Terminology**: renamed from "source-check" to "sourcing" in QUA-237. Prod still uses `/api/source-checks/*` path alias.
- **Research agent** (`crux/lib/search/research-agent.ts`): fires Exa + Perplexity + SCRY in parallel via `Promise.all`, merges URLs, dedups, fetches content (plain HTTP, falls back to Playwright). Optional GitHub, Semantic Scholar, Federal Register providers are off by default in backfill-sources.
- **Perplexity** uses `perplexity/sonar` via OpenRouter (cheap, fast web search). Not `deep-research` (too slow/expensive for per-record lookups).
- **SCRY** = `api.exopriors.com` — SQL-based search over EA Forum + LessWrong post materialized views. Public key hardcoded in `crux/lib/api-keys.ts`. Currently Cloudflare-blocked.
- **Playwright**: installed at workspace root now (not just in `apps/web`). Chromium browser binary installed via `pnpm exec playwright install chromium --with-deps`.

## API keys status

In `.env`:
- `ANTHROPIC_API_KEY` ✓
- `GITHUB_TOKEN` ✓
- `OPENROUTER_API_KEY` ✓
- `PROD_DATABASE_URL` ✓
- `PROD_LONGTERMWIKI_SERVER_API_KEY` ✓

Missing:
- `EXA_API_KEY`

## Gotchas

- **Stale resources snapshot → `resource-ref-integrity` gate failures on clean main.** `data/resources-snapshot.json` is a local fallback (not in git, refreshed daily in CI). If the pre-push gate fails with thousands of `<R id="sid_..."> does not match any known resource` errors on a branch you haven't touched, run `WIKI_SERVER_ENV=prod pnpm crux sys wiki-server snapshot-resources` (~30s). Symptom & fix now in `.claude/rules/pre-pr-verification.md` § 3.
