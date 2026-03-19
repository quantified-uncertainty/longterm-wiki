# Adversarial QA Sweep

Live site audit of longtermwiki.com. Fetches real pages via WebFetch and checks for broken rendering, data quality issues, and cross-page inconsistencies. Produces a prioritized findings report and files GitHub issues for real bugs.

This skill focuses **exclusively on the live production site**. Codebase checks are handled by `crux validate gate`, code review by `/review-pr` and `/audit`, and maintenance by `/maintain`.

**Schedule:** `/loop 24h /qa-sweep` for daily runs using your Claude Code subscription.

**Usage:**
- `/qa-sweep` — standard sweep across all directories (~10 min)
- `/qa-sweep legislation` — focus on one directory
- `/qa-sweep organizations,people` — focus on multiple directories
- `/qa-sweep --pages=/organizations/1day-sooner,/legislation/eu-ai-act` — specific URLs
- `/qa-sweep --depth=deep` — thorough audit with many subagents (~30 min)
- `/qa-sweep --depth=exhaustive` — maximum coverage, every directory + detail pages (~60 min)
- `/qa-sweep legislation --depth=deep` — deep audit of one directory

**Depth levels:**

| Depth | Index pages | Detail pages per dir | Agents | Time |
|-------|-------------|---------------------|--------|------|
| `quick` | All directories, surface checks | 0 | 2-3 | ~5 min |
| `standard` (default) | All directories | 3-5 per focused dir | 4-5 | ~10 min |
| `deep` | All directories | 10-15 per directory | 8-12 | ~30 min |
| `exhaustive` | All directories | ALL detail pages (sampled in batches) | 15-25 | ~60 min |

**Relationship to other commands:**
- `/maintain` — day-to-day cleanup (close issues, fix cruft, triage)
- `/audit` — strategic codebase review (complexity trends, architecture)
- `/qa-sweep` — live site audit (actively try to break things by looking at real pages)

## Argument parsing

Check `$ARGUMENTS` for focus areas and depth. Parse as follows:

```text
$ARGUMENTS = ""                                    → standard sweep, all directories
$ARGUMENTS = "legislation"                         → standard sweep, legislation only
$ARGUMENTS = "organizations,people"                → standard sweep, listed directories
$ARGUMENTS = "--depth=deep"                        → deep sweep, all directories
$ARGUMENTS = "legislation --depth=deep"            → deep sweep, legislation only
$ARGUMENTS = "--depth=exhaustive"                  → exhaustive sweep, all directories
$ARGUMENTS = "--pages=/path1,/path2"               → specific URL sweep
$ARGUMENTS = "--pages=/path1,/path2 --depth=deep"  → specific URLs + deep tab/cross-ref checks
```

**Directory name mapping** (argument → index route → entity type):

| Argument | Index route | Detail page pattern |
|----------|-------------|---------------------|
| `organizations` | `/organizations` | `/organizations/<slug>` |
| `people` | `/people` | `/people/<slug>` |
| `legislation` | `/legislation` | `/legislation/<slug>` |
| `ai-models` | `/ai-models` | `/ai-models/<slug>` |
| `benchmarks` | `/benchmarks` | `/benchmarks/<slug>` |
| `projects` | `/projects` | `/projects/<slug>` |
| `approaches` | `/approaches` | `/approaches/<slug>` |
| `events` | `/events` | `/events/<slug>` |
| `grants` | `/grants` | `/grants/<id>` |
| `publications` | `/publications` | `/publications/<slug>` |
| `research-areas` | `/research-areas` | `/research-areas/<slug>` |
| `funding-programs` | `/funding-programs` | `/funding-programs/<slug>` |
| `funding-rounds` | `/funding-rounds` | `/funding-rounds/<id>` |
| `divisions` | `/divisions` | `/divisions/<slug>` |

## Phase 0: Initialize sweep tracking

Before launching any agents, set up coverage tracking:

1. **Generate a sweep ID**: `sweep-YYYY-MM-DD-XXXX` (e.g., `sweep-2026-03-19-a1b2`)
2. **Get pages from the queue** instead of picking ad-hoc:
   ```bash
   pnpm crux qa-checks queue --directory=X --limit=N --json
   ```
   This returns pages ordered by staleness (never-checked first, then oldest). Use these pages for detail page selection instead of picking randomly from index pages.
3. **Show current coverage** for context:
   ```bash
   pnpm crux qa-checks coverage
   ```

## Phase 1: Index page audit

Launch agents **in parallel** using the Agent tool. Each agent fetches pages from `https://www.longtermwiki.com` using WebFetch and is research-only (no code changes).

**Agent strategy by depth:**

### Quick depth
- 1 agent: fetch all index pages, surface checks only

### Standard depth
- 1 agent per focused directory (or 1 agent covering all index pages if unfocused)
- 1 agent: detail page sampling (3-5 pages per focused directory)

### Deep depth
- **1 agent per directory**: each fetches the index page + 10-15 detail pages within that directory
- **1 cross-consistency agent**: checks that data matches across directories

### Exhaustive depth
- **1 agent per directory** (same as deep, but samples ALL detail pages in batches of 10)
- **2-3 cross-consistency agents**: one for financial data, one for people/org links, one for dates/timelines
- **1 accessibility agent**: checks for alt text, ARIA labels, keyboard navigation
- **1 stale data agent**: checks for outdated dates, references to past events described in future tense

### For each index page, check:
- Does it load (not 404/500)?
- Count consistency: does the filter badge total match the body count?
- Column fill rates: what percentage of rows have data in each column? Flag columns with >80% empty.
- Are there columns that should exist but don't? (e.g., tracked people count, completeness indicator)
- Do any values show raw IDs, slugs, or stableIds instead of human-readable names?
- Is the default sort order sensible?
- Are filter tabs useful? Flag any with 0 or 1 entries.
- Are descriptions truncated or missing?
- Any visible error messages, raw HTML/MDX, or rendering artifacts?

## Phase 2: Detail page audit

**Page selection strategy:**
- **Use the queue**: `pnpm crux qa-checks queue --directory=X --limit=N --json` returns pages ordered by staleness. Prefer these over random selection.
- Pick pages with diverse data states: one data-rich, one sparse, one mid-range
- At `deep`/`exhaustive` depth, systematically cover the full list using queue order

To find slugs for detail pages, look at the index page content — it contains links. Pick from those.

**For each detail page, check:**
- Does it load (not 404/500)?
- Do tabs use URLs (e.g., `/organizations/slug/people`) or are they JS-only?
- Do People references show names with links to `/people/<slug>`, or raw IDs?
- Are tables sorted sensibly (most recent first for dates)?
- Are any tabs/sections completely empty? Should they be hidden?
- Any visible error messages, raw HTML/MDX, or rendering artifacts?
- Check **every tab** — Overview, People, Funding, Announcements, Press, etc.
- Do numbers/dates look plausible? (e.g., founding date before current year, funding amounts in reasonable range)
- Are there stale claims? ("upcoming" events that already happened, "as of 2024" when it's 2026)

## Phase 3: Cross-consistency checks (deep/exhaustive only)

Launch a dedicated agent to verify data consistency across pages:
- Does an org's "Total Funding" on the org page match the sum of grants on `/grants`?
- Do people listed on an org's People tab have that org as their affiliation on `/people`?
- Do "Related Organizations" on entity pages link bidirectionally?
- Do dates agree (founded date on org page vs. earliest grant date)?
- Do entity counts on index pages match what detail pages show?

## Phase 4: Compile findings

Wait for all agents to complete. Compile a deduplicated, prioritized report:

```markdown
## QA Sweep — [DATE]
### Focus: [directory name or "full sweep"] | Depth: [quick/standard/deep/exhaustive]
### Agents launched: N | Pages checked: N

### P0 — Active bugs (user-visible now)
[Table: #, Bug, URL, Description]

### P1 — Latent bugs (will surface under conditions)
[Table: #, Bug, URL, Description]

### P2 — UX improvements
[Table: #, Issue, URL, Description]

### Data completeness
[Per-column fill rates for each index page checked]

### Cross-consistency issues (deep/exhaustive only)
[Table: #, Mismatch, Page A, Page B]

### Confirmed clean
[Bullet list of areas checked and found clean]
```

## Phase 5: Record results, file issues, and persist the report

### Record check results — MANDATORY

After compiling findings, record every page checked to the coverage tracking system. For each page that was checked:

```bash
pnpm crux qa-checks record --url=/organizations/anthropic --result=clean --directory=organizations --sweep-id=sweep-2026-03-19-a1b2 --depth=standard
```

Valid `--result` values: `clean`, `issues_found`, `error`, `404`

For bulk recording, you can use `pnpm crux qa-checks record` for each page. This updates the coverage database so future sweeps avoid re-checking recently-audited pages.

### Show updated coverage

After recording all results:
```bash
pnpm crux qa-checks coverage
```

Include the coverage table in the report.

### Issue filing — MANDATORY for all confirmed findings

**QA sweeps override the normal conservative filing limits.** The whole purpose of a sweep is to find and file issues. Rules:

- **File one GitHub issue per finding** (P0, P1, and P2). Do not batch unrelated issues into umbrella issues.
- Closely related findings (e.g., 5 entities with the same data problem) may be grouped into one issue.
- Use `pnpm crux issues create` with `--model=haiku` for each.
- **Expected volume:** 5-15 issues per deep sweep is normal. The daily cap of 5 from `proactive-github-filing.md` does NOT apply to QA sweeps.
- **Do NOT skip P1 and P2 filing.** Every confirmed finding must become a GitHub issue.

### Persist the full report to a GitHub Discussion

After filing issues, post the **complete** Phase 4 report as a comment on Discussion #2650 (QA Sweep Reports).

```bash
pnpm crux epic comment 2650 "$(cat <<'REPORT'
## QA Sweep — [DATE]
### Focus: [focus] | Depth: [depth]
[Full report here — copy the entire Phase 4 output]

### Issues filed
- #N: title
- #N: title
...
REPORT
)"
```

### Fix P0s

| Severity | Action |
|----------|--------|
| **P0** (active bug) | Fix it now in a branch, open a PR |
| **P1** (latent bug) | File a GitHub issue (already done above) |
| **P2** (quality/UX) | File a GitHub issue (already done above) |

After fixing P0s, run `/push-and-ensure-green` to ship.

## Guardrails

- **Do not fix P1/P2 issues during the sweep** unless they are one-line changes. File issues instead.
- **Evidence over impressions.** Every finding must reference a specific URL you actually fetched.
- **No false positives.** Only report issues you have confirmed by fetching the actual page.
- **Time box.** Quick: ~5 min. Standard: ~10 min. Deep: ~30 min. Exhaustive: ~60 min.
- **Parallelize aggressively.** Launch all independent agents in a single message.
- **File generously.** If you found it and confirmed it, file it.
