# Backfill-sources pipeline — change notes

Cumulative summary of every change made on the `claude/resource-pipeline-triage-v2` branch to the source-URL backfill pipeline. PR #4497.

## What it is

`crux tb backfill-sources` finds source URLs for the ~1,050 wiki records that have a value (a fact, a personnel role, an investment, etc.) but no `source` field. End-to-end pipeline: search the web → verify → write the URL.

Runs via:

```
pnpm crux tb backfill-sources --apply --limit=N
# or
dev/run-backfill-and-verify.sh [LIMIT] [BUDGET]   # also runs verdict step
DRY_RUN=1 dev/run-backfill-and-verify.sh 5         # preview only
```

## Pipeline today (per record)

1. **Find candidates** — wiki-server `/api/sourcing/missing-sources` returns rows from 10 tables that have a NULL/empty source.
2. **Search the web** — Exa + Perplexity + SCRY in parallel; URLs deduped.
3. **Fetch top URLs** — page text extracted (Playwright fallback for JS-heavy pages).
4. **Drop self-domain hits** — `longtermwiki.com`, `longtermwiki.org`, `longterm.wiki`, `longterm-wiki.vercel.app`, `ea-crux-project.vercel.app`.
5. **Cheap entity-mention pre-filter** — for personnel records both the person AND the org must appear; for everything else just the entity. Multiple variants tried (literal, slug-as-words, accent-stripped, parenthetical alias, surname-only, URL host/path).
6. **Haiku quote extraction** — small model returns up to 3 short verbatim passages from the page that support the claim.
7. **Substring verification** — each quote must really exist in the page (alphanumeric-normalised compare). Fabricated quotes are dropped.
8. **Sonnet entailment** — strong model receives `(claim, verified-quotes, source URL, source title)` and answers yes/no on whether the quotes prove the claim.
9. **Multi-candidate ranking** — if multiple pages survived, Haiku picks the best one.
10. **Write or report** — `--apply` writes the chosen URL via the unified update-source endpoint; `--dry-run` just logs.
11. **Per-run output** — counts, per-cost-category breakdown, per-provider winning rollup, and `dev/reports/backfill-unmatched-<timestamp>.json` with reasons for triage.

## Change log (chronological)

### Endpoint — `apps/wiki-server/src/routes/sourcing/missing-sources.ts`

- Added `GET /api/sourcing/missing-sources` (and a test). Queries 10 tables for NULL-source records, JOINed to `entities` for human-readable names. Per-table query functions wrapped in a `safeQuery()` so one bad table doesn't kill the response.
- Filters out metadata facts (website, description, logo, image) where source-checking is meaningless.
- Catches up to schema renames that landed on main during this branch's life.
- **Policy stakeholders now expose the policy name** — added a second LEFT JOIN (`polE = alias(entities, "pol_e")`) on `policyStakeholders.policyEntityId`, surfacing `policy_name` (falling back to the raw entity ID when the join fails). The `description` SQL now also includes the policy: `"<stakeholder> (<position>) on <policy>"`. Without this, claims sent to Sonnet were structurally unverifiable ("Amazon takes the 'support' position on this policy" — but which policy?).

### CLI — `crux/commands/backfill-sources.ts`

- New command + tests. Pulls candidates, searches the web, verifies, optionally writes.
- **Self-domain filter** — added Vercel preview (`longterm-wiki.vercel.app`) and `ea-crux-project.vercel.app` so we don't source the wiki against itself.
- **Direct Anthropic SDK only** — earlier OpenRouter fallback was bolted on while we lacked credits and has been removed.
- **Per-record outcome JSON** — every unmatched record written to `dev/reports/backfill-unmatched-<timestamp>.json` with reason; opt-in `--verbose` flag prints the per-record list inline.
- **Single-record smoke flag** `--record-id=<id>` for one-record E2E testing.
- **`--debug` flag** prints per-URL decisions inline (entity-mention pass/fail, Haiku quote text, substring-check pass/fail, Sonnet verdict).
- **Per-source winning rollup** — summary lists how many winning URLs came from each provider (`exa`, `perplexity`, `exa+perplexity`, …). Required adding `provider?: string` to `SourceCacheEntry` and tracking provider attribution through dedup in `research-agent.ts`.
- **Per-cost-category breakdown** — summary breaks the run cost into Perplexity search / Haiku fact-extract / Haiku quote-extract / Sonnet entailment / Haiku ranking.

### Verification pipeline overhaul (was the big rewrite)

The original "the article must contain the value phrase verbatim" check was rejecting most coverage because real articles paraphrase ("led Tesla's AI team" vs the wiki's "Former Director of AI at Tesla"). Replaced with a 4-step LLM pipeline:

1. **Cheap entity-mention check** — page must mention the relevant entity name(s) (substring with several normalisations).
2. **Haiku quote extraction** — Haiku returns up to 3 short verbatim passages that together support the claim. Multiple quotes allow evidence assembled from non-adjacent parts of an article (originally Haiku stitched fragments into a single fake sentence; the multi-quote approach lets it return them separately).
3. **Quote-in-page substring check** — verifies each quote really exists in the page. Normalisation tolerates HTML entities, footnote markers (`[1]`), unicode punctuation, whitespace differences.
4. **Sonnet entailment** — strong model judges whether the verified quotes (with the source URL and title as anchor context) actually prove the claim. URL anchor was added later: a sparse quote like `"Jacob Haimes\n\nResearch Manager"` lifted from `apartresearch.com/impact` only entails the role claim if the entailment LLM knows the page is on apartresearch.com.

The Sonnet prompt now uses **few-shot examples** drawn from real-world failure patterns to allow routine inference: co-founder ⇒ equity-holder, named in a Series G round ⇒ Series G institutional position, name on org's own /about page ⇒ employment relationship. Counter-examples included: paper co-authorship alone does NOT entail employment; different number/date/entity than claimed → no.

### Entity-mention helper (`contentMentionsEntity`)

Accepts a match when **any** of these is present:

- the literal entity name in the content
- a slug-to-words variant (`center-for-ai-safety` → `center for ai safety`)
- an accent-stripped variant (handles wiki-vs-source spelling differences)
- the entity name appearing in the URL hostname or path (pages on the org's own domain pass even when the body uses "we" / "our program")

### Mention slot generation (`entitiesToMention`)

Returns `string[][]`: each slot is OR'd internally; all slots must match.

- For **personnel** records, two slots: person variants AND org variants. (An article about Andy Zou's PhD work alone shouldn't pass as evidence for his CAIS role.)
- For **page_citations** records, returns `[]` — the "entity" is the wiki page itself ("Page #201"), not a real-world entity, so the entity-mention check is skipped entirely and we rely on Haiku/Sonnet to judge claim support.
- For other records, one slot — the entity itself (with `orgNameVariants` applied).
- **`personNameVariants`** — full name, plus first+last (3+-word names), plus surname alone (≥5 chars). Handles cases like `"Natalia Perez-Campanero Antolin"` matching pages that just say "Antolin".
- **`orgNameVariants`** — pulls out parenthetical aliases. `"Andreessen Horowitz (a16z)"` → also tries "Andreessen Horowitz" and "a16z".
- **`rejectIfMachineId`** — drops entity names starting with `sid_` (unjoined-stableId leaks); the slot is treated as missing rather than the search chasing a meaningless string.

### Test-record skip

Records with `entity_name === 'Test'` or `record_id === 'test123456'` are skipped in the outer loop with outcome kind `'skipped'` (not `'no-match'`) at zero LLM cost. Counted alongside other skip categories in the summary; doesn't pollute the no-match bucket or the unmatched-rate denominator.

### Per-record outcomes JSON includes matched items + their quotes

The output JSON (default `dev/reports/backfill-unmatched-<ts>.json`, override `--unmatched-out=PATH`) now contains every record's outcome, not just the unmatched ones:

- `outcome: 'matched'` items include `url`, `provider`, `cost_usd`, **and `quotes: [...]`** — the verbatim passages Sonnet judged as supporting the claim. Lets a human spot-check for false positives without re-running.
- `outcome: 'no-match'` items include `reason` + `cost_usd`.
- `outcome: 'skipped'` items include `reason` (no cost).

Each row also has a `claim` field — the humanised version sent to the LLM — for context when reviewing.

### Claim humanisation (`humanizeClaim`)

The raw `description` field uses cryptic shapes like `"Y Combinator -> Ello"` that Sonnet can't reliably interpret. Per-table renderer table converts each into natural language before sending to the LLM:

- investments: `"Y Combinator -> Ello"` → `"Y Combinator invested in Ello"` (with `(round: Series G)` suffix when present)
- equity_positions: `"X in Y"` → `"X holds equity in Y"`
- personnel: `"Andy Zou at center-for-ai-safety (Researcher)"` → `"Andy Zou works at center-for-ai-safety as Researcher"`
- facts: `"Total Funding Raised = 15000000000"` → `"Anthropic's Total Funding Raised is 15000000000"` (possessive form, raw value preserved so source-page formats can match flexibly)
- divisions / policy_stakeholders / funding_rounds / funding_programs — same per-type pattern.
- page_citations: returns the description directly (the citation text IS the claim).
- Falls back to raw description if required fields are missing.
- `f()` field-reader strips `sid_*` machine-id leaks so they never appear in the humanised claim either.

### Source content packing (`crux/lib/search/research-agent.ts`)

- `runResearch()` previously set `source.content` to ONLY the search-keyword-filtered excerpts (`relevantExcerpts`). Paragraphs without query tokens were dropped, so an entity-name mention sitting in a non-query-matching paragraph (e.g. `"Andy Zou - Future of Life Institute"` in a header) was lost.
- Now `source.content = excerpts + "--- additional page content ---" + first 6K chars of full body`. Both focused snippets and unfiltered context are available downstream.
- Extracted `packContent(fetched)` helper — single canonical assembly logic, called from both budget-exhausted and normal branches.

### Cost tracking

- `CostBreakdown` now has 5 categories: `searchCost`, `factExtractionCost`, `quoteExtractCost`, `entailmentCost`, `rankCost`.
- `emptyCost()` + `totalOf()` helpers used everywhere; no manual sums.
- Bug fixed where the totals rollup wasn't summing the new quote/entailment categories.

### SCRY API

- **Endpoint URL fix** — `api.exopriors.com` → `api.scry.io` across `crux/lib/search/research-agent.ts`, `crux/authoring/creator/research.ts`, `crux/authoring/page-improver/api.ts`. Old host was dead.
- **Per-query exposure cap** — added `x-scry-max-exposure: 10000000` header (~$0.01/query) so substantive search queries don't hit the default ~$0.000347 cap (`query_exposure_exhausted` 402).
- Free-tier daily budget (~$0.05/day) is a separate cap — top up the SCRY key before scheduling cron runs.

### Wrapper script — `dev/run-backfill-and-verify.sh`

End-to-end runner: stage 1 backfill-sources → stage 2 verify backfill (snapshot + verdict). `DRY_RUN=1` skips both writes.

### Misc

- **playwright** — declared in root `package.json` (was implicitly required by `crux/visual/visual-review.ts` and now by `crux/commands/tablebase.ts:624`'s headless content fetcher; previously the require always failed and visual-review's screenshot path was effectively dead).
- **`apps/web/.../market-data-section.tsx`** — removed `SourcingDot` from secondary-market and prediction-market tables (those record types have no sourcing verdicts → broken `/sourcing` 404s).
- **`dev/dev-env.sh`** — `psql` now uses `-T` (no TTY) so `cat foo.sql | dev/dev-env.sh psql` works; new `psql-prod` subcommand for one-off prod queries via `PROD_DATABASE_URL`.
- **`dev/test-scry.sh`** — quick SCRY connectivity smoke test.
- **`.claude/architecture.md`** — new system overview (cron + scheduler + queue worker).
- **`.claude/rules/pre-pr-verification.md`** — documented the stale-resources-snapshot gate-failure mode and the silent-pre-push-failure case.
- **`.gitignore`** — `dev/sql/`, `dev/reports/`.

## Match-rate trajectory at limit=5 (33 records)

| Pipeline state | Matched | Cost |
|---|---|---|
| Original verbatim-match | 8 / 33 | $0.24 |
| + Multi-quote Haiku + Sonnet entailment | 17 / 33 | $0.26 |
| + Entity-mention slug+person+URL fixes + humanizeClaim + Sonnet anchor | 25 / 63 (limit=10) | $0.68 |
| + Loosened Sonnet entailment with few-shot examples + page_citations skip + facts renderer + sid filter + test-record skip | 27 / 63 (limit=10) | $0.70 |
| + Policy name in policy_stakeholder claims + matched JSON now includes quotes for FP audit | 41 / 62 (limit=10, 1 test-record skipped) | $0.88 |

≈66% match rate. Remaining unmatched are split between: genuine no-source-available cases (stale wiki data, search discoverability gaps), and structural data issues (policies without joined entities, personnel with wrong affiliation in the wiki). Sonnet false-positive rate not yet audited — the matched JSON now contains the supporting quotes specifically so a human can verify.

## Required env vars for prod cron

- `LONGTERMWIKI_SERVER_URL`, `LONGTERMWIKI_SERVER_API_KEY`
- `ANTHROPIC_BILLING_KEY` — Haiku (quote extraction + ranking) + Sonnet (entailment)
- `EXA_API_KEY` — finds most of the relevant results
- `OPENROUTER_API_KEY` — Perplexity
- `SCRY_API_KEY` — paid-tier key recommended; free tier hits ~$0.05/day cap

## Tests

`crux/commands/backfill-sources.test.ts` — 95 unit tests covering:
- `extractMatchTerms` (per record-table extraction)
- `contentMatchesRecord` (legacy verbatim check, kept for reference)
- `contentMentionsEntity` (literal / slug-as-words / accent / URL-host paths)
- `personNameVariants` (full / first+last / surname-only with ≥5-char rule)
- `orgNameVariants` (parenthetical alias splitting)
- `verifyQuoteInContent` (verbatim / whitespace / HTML entities / fabricated / stitched)
- `parseQuoteResponse` / `parseEntailmentResponse` (JSON parsing + fallbacks)
- `buildQuoteExtractionPrompt` / `buildEntailmentPrompt` / `buildRankingPrompt` (shape + injection-resistance)
- `humanizeClaim` per record-table renderer + fallthrough (uses `mkRecord` helper for fixture brevity)
- `isSelfDomain` (positive + lookalike rejections)

## Open follow-ups before prod

- **Audit Sonnet false-positive rate** — read 15-20 matched items from the outcomes JSON (now includes quotes); if ≥3 are sloppy, tighten the entailment prompt or add a stricter-model second pass.
- Audit existing `backfill-sources.test.ts` for stale assertions on the now-unused `contentMatchesRecord` flow (decide: delete the obsolete tests + the dead function, or keep both as legacy).
- `pnpm test` green workspace-wide.
- 50–100 record `--apply` smoke run with cost + latency observed.
- Diff-and-push flow: write source URLs to a local snapshot, diff against prod, only push deltas back (avoids live prod write, gives a reviewable changeset).
- Surface unmatched-items JSON somewhere humans see (dashboard / Discord / Linear).
- Provision prod env vars: `ANTHROPIC_BILLING_KEY`, `EXA_API_KEY`, `OPENROUTER_API_KEY`, paid-tier `SCRY_API_KEY`.
- GitHub Actions cron workflow `.github/workflows/backfill-sources.yml` (schedule + `--apply` + `--max-cost` + secrets wiring).
- Decide whether to ship as stage 1 only or wait for verdict orchestrator + triage UI.
