# Backfill-sources — known bugs / fixes

Findings from inspecting `dev/reports/backfill-unmatched-2026-04-26T02-58-09-103Z.json`
(91 records: 51 matched, 39 no-match, 1 skipped).

---

## Auto-source: facts where the value is already a URL ✅ DONE (2026-04-26)

- **fix:** when a fact's value is itself a URL (Google Scholar links, websites, profile URLs), use that URL as the source — no web search needed.
- **affects:** ~2 no-match items per 91-record run; recurring forever.
- **shipped:** short-circuit in the backfill tool — `crux/lib/backfill-sources/process-record.ts::selfSourcingUrl` runs before any search and writes the URL straight back via `--apply`. Provider tagged as `self-sourced` in the report. +8 tests in `crux/commands/backfill-sources.test.ts`.

## Claim renderer drops the entity name ✅ DONE (2026-04-26)

- **bug:** for some `facts` rows the rendered claim was just `"Total Funding Raised = 15000000000"` / `"Headcount = 4074"` / `"Safety Researchers = 120"` — no entity name. The search query was then near-useless.
- **shipped:** commit `5427e98e2` — `queryFacts` description now prepends the entity title: `COALESCE(entity.title, facts.entityId) || ': ' || ...`. (The original diagnosis was wrong — the join wasn't failing; the SQL just didn't reference the entity title in the description string.) The new per-table query builder (`build-search-query.ts`) plus `humanize-claim.ts` now produce focused, entity-named queries per record_table.
- **affects:** 3 no-match items in the original report; recurring forever.

## Skip subjective / internal estimates — DEFERRED (2026-04-26)

- **fix:** add measures like `EA Alignment Estimate` (and similar internal-judgement fields) to `SKIP_MEASURES` in `missing-sources.ts` — they're un-sourceable by design.
- **affects:** 2 no-match items.
- **investigation 2026-04-26:** ran `SELECT measure, label, value, source FROM facts WHERE measure IN ('charity-rating','organizational-rating','ea-alignment-estimate')`.
  - `charity-rating` / `organizational-rating` → real third-party scores (Charity Navigator, etc.) with `source` URLs already filled. NOT skip candidates.
  - `ea-alignment-estimate` (9 rows) → mostly no source, but **one row has a Jaan Tallinn LessWrong source** (`/posts/.../jaan-tallinn-s-2024-philanthropy-overview`). So the measure is ambiguous: some are internal opinions, some are published EA-community estimates. Excluding the whole measure would lose the sourceable ones.
- **decision:** do not skip `ea-alignment-estimate` for now. Revisit if a smarter per-row predicate emerges (e.g. only skip when the value is a numeric range with no claim language).

## Resolve raw slugs to display names in claims — DEFERRED to [QUA-762](https://linear.app/quantifieduncertainty/issue/QUA-762/personnelinvestmentsetc-free-text-org-refs-not-foreign-keyed-to) (2026-04-26)

- **bug:** claim renders as `"Andy Zou works at center-for-ai-safety as Researcher"` — using the slug instead of the display name. The CAIS website says "Center for AI Safety", so the entity-mention check fails on legitimate sources.
- **investigation 2026-04-26:** the personnel row stores `organization_id='center-for-ai-safety'` and `org_entity_id=NULL`, but **no entity exists with id `center-for-ai-safety`** — the actual org is `id='cais'`, `title='Center for AI Safety (CAIS)'`. So this isn't a join-fallback bug; the data itself is broken (free-text orgs not FK'd to entities). Same shape likely affects investments, equity_positions, etc.
- **affects:** 1 confirmed no-match (Andy Zou); likely many more in larger runs.
- **decision:** filed QUA-762 to backfill `org_entity_id` across personnel + sibling tables and add a constraint. Too broad for this task list.

## QURI-style parenthetical aliases not used in search query ✅ DONE (2026-04-27)

- **bug:** entity name `"QURI (Quantified Uncertainty Research Institute)"` — `orgNameVariants` splits parens for the entity-mention check but the search query still uses the full literal string, so search providers don't surface QURI's own pages well. Investigation showed the deeper issue: the old query was `entity_name + " " + description`, and for personnel `description` already embedded the entity name → duplicate org names, parens, useless query.
- **shipped:** new per-table query builder (`crux/lib/backfill-sources/build-search-query.ts`). Personnel/investments/equity_positions/policy_stakeholders/facts/page_citations/divisions/funding_rounds/funding_programs each compose a focused query from structured fields. Parenthetical aliases collapse to the shortest variant (so QURI-the-alias is used, not the full registered name). +8 tests in `crux/commands/backfill-sources.test.ts`.
- **before/after** (sampled live via `dev/preview-search-queries.mjs`):
  - personnel: `QURI (Quantified Uncertainty Research Institute) Ozzie Gooen at QURI (...) (Executive Director)` → `Ozzie Gooen QURI Executive Director`
  - facts: `Anthropic Anthropic: Total Funding Raised = 15000000000` → `Anthropic Total Funding Raised 15000000000`
  - investments: `Andreessen Horowitz (a16z) Andreessen Horowitz (a16z) -> Playground` → `a16z invested in Playground Seed`
  - page_citations: `Page #201 METR's evaluations serve as...` → `METR's evaluations serve as...`

## `sid_` machine-id leak in claim text ✅ DONE (2026-04-27)

- **bug:** claim rendered as `"Y Combinator -> sid_Storyworth"` instead of `"Y Combinator invested in Storyworth"`.
- **investigation:** local DB has 7 investments rows with `company_entity_id = NULL` and `company_id` starting with `sid_`. Two flavors:
  - **Title-with-prefix (2 rows):** `sid_Storyworth`, `sid_Playground` — entities exist (`storyworth`/`sid_kT85f91plA`, `playground-ai`/`sid_kh5x0eezrQ`) but the FK was never set.
  - **Orphan sids (5 rows):** `sid_QwuDJJ2oCQ`, `sid_JSTlUS21fw`, `sid_WwAmF2Cbsw`, `sid_WeNdB0RAzA`, `sid_FFpr62MPQg` — well-formed sids that don't match any current entity.
  - The other 22 unresolved rows had perfectly valid human-readable `company_id` fallbacks (Algolia, Ello, Zapier, etc.) and should NOT be skipped.
- **shipped:** added `nameIsUsable(joinedTitle, rawFallback)` SQL helper in `apps/wiki-server/src/routes/sourcing/missing-sources/queries.ts` — returns true iff the resolved display value (entity title OR raw column) is non-empty AND doesn't start with `sid_`. Wired into the WHERE clause of all 9 entity-joining queries (facts, personnel, investments, equity_positions, policy_stakeholders, divisions, funding_rounds, funding_programs, publications). Count queries now mirror the relevant left-joins so totals stay consistent. Verified on local DB: 2 corrupt investments rows skipped, 45 valid rows still flow through.
- **data cleanup:** filed [QUA-764](https://linear.app/quantifieduncertainty/issue/QUA-764/investments-7-rows-with-sid-leak-in-company-id-null-company-entity-id) for the 7 corrupt investments rows + audit of sibling tables. Same shape likely lives elsewhere.

## Duplicate division rows

- **bug:** Coefficient Giving "Criminal Justice Reform" appears 3× as separate rows in `divisions`, all matched to the same URL.
- **fix:** dedupe at the data-source layer — the underlying YAML/PG should not have 3 identical division rows.

## Report PG cache contribution

- **bug:** the existing-link database lookup runs every time but its contribution is invisible in the run report (only winning provider is tracked). When 0 of 51 wins came from the cache, we can't tell whether that's because the cache had nothing to offer or because the web result outranked it every time.
- **fix:** in the run summary, also report: PG hits found total, PG hits that survived verification, PG/web overlap count.

## Verbose: per-record provider breakdown for matched ✅ DONE (2026-04-27)

- **shipped:** every matched item in `backfill-unmatched-*.json` now carries `providers: string[]` next to the existing `provider` string. `research-agent` already encodes multi-provider hits as `'exa+perplexity'` (sorted, `+`-joined); `splitProviders()` in `crux/lib/backfill-sources/report.ts` splits + trims + dedupes back into an array. Aggregating provider weights from past runs no longer requires re-parsing.
- **also:** split the 841-line `crux/commands/backfill-sources.test.ts` into 8 colocated per-module test files under `crux/lib/backfill-sources/`. 127 tests, same coverage.

---

Findings added 2026-04-26 from `backfill-unmatched-2026-04-26T15-44-15-402Z.json`
(113 records: 65 matched, 47 no-match, 1 skipped). DB write sanity-check
came back clean (65/65 URLs written without corruption — see
`dev/verify-backfill-db.mjs`).

## Reject draft / placeholder URLs at match time ✅ DONE (2026-04-27)

- **bug:** `equity_positions/wxX0RqD379` (Google/Alphabet → Anthropic) matched to `https://theverge.com/news/627849/auto-draft` — a literal in-progress / draft article.
- **shipped:** `isPlaceholderUrl()` in `crux/lib/backfill-sources/verify-source.ts`, called in `verifySource()` right after the self-domain check (cheap, free). New rejection reason `placeholder-url` flows through the debug log and the report-rollup `summarizeRejections()`.
- **patterns kept (tight):** `/auto-draft` (exact WP slug), `/wp-admin`, `?p=NNNN` (raw WP post-id), `/YYYY-MM-DD` (date-only archive).
- **patterns rejected as too aggressive:** `/draft-*` (would block real legal articles like `/draft-bill-on-ai-safety`) and `/preview/*` (real news/sports content lives there: `/preview/2025-nfl-draft`, `/preview/q3-earnings`). Tests assert these still pass through.
- **affects:** 1 confirmed FP fixed; pattern likely recurs.

## Soft-warn matches where no extracted quote names the entity

- **bug:** ~14 of 65 matched URLs have quotes that don't literally contain the entity's first-name token (e.g. UK Government's AISI position → `gov.uk/.../ai-safety-institute`; Coefficient Giving CJR division → `coefficientgiving.org/research/criminal-justice-reform`). These are *often* valid (entity is the page subject) but they're also the FP-prone ones.
- **fix:** add a "weak-mention" boolean to each matched outcome in the report and a per-run rollup count. No need to reject — just surface them so triage can sample.
- **affects:** 14 of 65 in this run; useful triage signal regardless.

## "X supports policy Y" claims not surfacing public press

- **bug:** Anthropic's and Google DeepMind's positions on the Seoul Declaration on AI Safety both ended in `no-match` despite being widely covered in press. Y Combinator → Ello (W23) also no-matched even though YC has a portfolio page for Ello. These aren't covered by the slug-to-display-name or parenthetical-alias fixes — the entity names are plain.
- **fix (investigate):** likely the search-query template for `policy_stakeholders` and `investments` claims isn't producing strong queries for "X supports policy Y" / "X invested in Y in batch Z". Consider templating these per-table claim-types instead of the generic claim-text-as-query.
- **affects:** 3+ no-match items.

## Provider weighting by historical hit rate — DEFERRED indefinitely (2026-04-27)

- **idea:** after a few hundred matched records, compute per-provider (Exa/Perplexity/SCRY/PG) win rates per `record_table`, then bias the merge step in `runResearch` to favor the provider with the highest historical hit rate. Could lift match rate ~2-3%.
- **decision:** deferred until we actually have the data. The new `providers: string[]` field in the report (shipped 2026-04-27) is the prerequisite — once a few hundred matched records have accumulated we can revisit. No ETA.

## Sanity-check DB writes from the wrapper script

- **fix:** after the backfill stage in `dev/run-backfill-and-verify.sh` (or as the first step of the verify stage), call `node dev/verify-backfill-db.mjs $REPORT` and bail loudly on any mismatch / NULL / corruption finding. Cheap insurance against future endpoint regressions like the URL-path 404 bug we just fixed.
