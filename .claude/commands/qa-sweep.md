# Adversarial QA Sweep

Systematic adversarial audit of the wiki. Finds bugs, broken pages, regressions, and data integrity issues. Produces a prioritized findings report and files GitHub issues for real bugs.

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
| `quick` | All directories, surface checks | 0 | 3 | ~5 min |
| `standard` (default) | All directories | 3-5 per focused dir | 4-5 | ~10 min |
| `deep` | All directories | 10-15 per directory | 8-12 | ~30 min |
| `exhaustive` | All directories | ALL detail pages (sampled in batches) | 15-25 | ~60 min |

**How it works:**
1. `pnpm crux qa-sweep` runs deterministic checks (duplicate IDs, broken refs, tests, gate)
2. This skill adds LLM-driven agents on top (production site audit, code review of recent changes)
3. Findings are compiled into a P0/P1/P2 report
4. P0 bugs get fixed; P1/P2 get filed as GitHub issues

**Relationship to other commands:**
- `/maintain` — day-to-day cleanup (close issues, fix cruft)
- `/audit` — strategic review (complexity trends, architecture)
- `/qa-sweep` — adversarial (actively try to break things)

## Argument parsing

Check `$ARGUMENTS` for focus areas and depth. Parse as follows:

```
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

| Argument | Index route | Entity type | Detail page pattern |
|----------|-------------|-------------|---------------------|
| `organizations` | `/organizations` | `organization` | `/organizations/<slug>` |
| `people` | `/people` | `person` | `/people/<slug>` |
| `legislation` | `/legislation` | `policy` | `/legislation/<slug>` |
| `ai-models` | `/ai-models` | `ai-model` | `/ai-models/<slug>` |
| `benchmarks` | `/benchmarks` | `benchmark` | `/benchmarks/<slug>` |
| `projects` | `/projects` | `project` | `/projects/<slug>` |
| `approaches` | `/approaches` | `approach` | `/approaches/<slug>` |
| `events` | `/events` | `event` | `/events/<slug>` |
| `grants` | `/grants` | — | `/grants/<id>` |
| `publications` | `/publications` | — | `/publications/<slug>` |
| `research-areas` | `/research-areas` | `research-area` | `/research-areas/<slug>` |

## Phase 1: Deterministic checks

Run the crux command to get automated check results and recent change context:

```bash
pnpm crux qa-sweep
```

If a focus area was specified, also run targeted checks:

```bash
# For each focused entity type:
pnpm crux validate directory-pages --type=<entityType> --verbose
pnpm crux matrix scores --type=<entityType>
```

Read the output. Note:
- Which checks failed or warned
- Which areas had the most recent changes (these get priority in Phase 2)
- Which entity types have the worst scores (these get extra detail page sampling)

## Phase 2: LLM-driven audits

Launch agents **in parallel** using the Agent tool. Each agent is research-only (no code changes).

**Agent strategy by depth:**

### Quick depth
- 1 agent: fetch all index pages, surface checks only
- 1 agent: code quality on recent changes
- 1 agent: wiki-server route audit

### Standard depth
- 1 agent per focused directory (or 1 agent for all index pages if unfocused)
- 1 agent: detail page sampling (3-5 pages per focused directory)
- 1 agent: code quality on recent changes
- 1 agent: wiki-server route audit

### Deep depth
- **1 agent per directory**: each fetches the index page + 10-15 detail pages within that directory
- **1 cross-consistency agent**: checks that data matches across directories (e.g., org page funding total matches grants page, person affiliations match org people tabs)
- **1 agent per audit type**: code quality, wiki-server routes
- **1 component code agent**: reads the actual React components for focused directories, checks for bugs in rendering logic

### Exhaustive depth
- **1 agent per directory** (same as deep, but samples ALL detail pages in batches of 10)
- **2-3 cross-consistency agents**: one for financial data, one for people/org links, one for dates/timelines
- **1 agent per audit type**: code quality, wiki-server routes, schema validation
- **1 component code agent per directory**: reads rendering components
- **1 accessibility agent**: checks for alt text, ARIA labels, keyboard navigation
- **1 stale data agent**: checks for outdated dates, dead external links, references to old events

### 2a. Production site audit — Index pages

Launch agents to fetch pages from `https://www.longtermwiki.com` using WebFetch.

**For each index page, check:**
- Does it load (not 404/500)?
- Count consistency: does the filter badge total match the body count?
- Column fill rates: what percentage of rows have data in each column? Flag columns with >80% empty.
- Are there columns that should exist but don't? (e.g., tracked people count, completeness indicator, subentity counts)
- Do any values show raw IDs or slugs instead of human-readable names?
- Is the default sort order sensible?
- Are filter tabs useful? Flag any with 0 or 1 entries.
- Are descriptions truncated or missing?
- Any visible error messages or raw HTML/MDX?

### 2b. Production site audit — Detail pages

**Page selection strategy:**
- Pick pages with diverse data states: one data-rich, one sparse, one mid-range
- Pick from different parts of the alphabet
- At `deep`/`exhaustive` depth, systematically cover the full list

To find slugs for detail pages, look at the index page content — it contains links. Pick from those.

**For each detail page, check:**
- Do tabs use URLs (e.g., `/organizations/slug/people`) or are they JS-only?
- Is the description placed under "Overview" or floating in the header?
- Does "Related Pages" appear? Should it say "Related Wiki Pages"?
- Do People references show names with links to `/people/<id>`, or raw IDs?
- Are tables sorted sensibly (most recent first for dates)?
- Are any tabs/sections empty or nearly empty?
- Is "Source" inline or its own column?
- Are there sections that don't belong on the default tab?
- Check **every tab** — Overview, People, Funding, Announcements, Press, etc. Each tab is a separate check.

### 2c. Cross-consistency checks (deep/exhaustive only)

Launch a dedicated agent to verify data consistency across pages:
- Does an org's "Total Funding" on the org page match the sum of grants on `/grants`?
- Do people listed on an org's People tab have that org as their affiliation on `/people`?
- Do "Related Organizations" on entity pages link bidirectionally?
- Do dates agree (founded date on org page vs. earliest grant date)?
- Do entity counts on index pages match what detail pages show?

### 2d. Code quality audit

Launch an agent to read recently changed files (from Phase 1 output) and check for:
- Logic errors, off-by-one, null safety
- Silent error swallowing (`.catch(() => {})`)
- Type safety issues (`as any`, `as unknown as T`)
- Broken imports or stale references
- Missing `"use client"` directives
- SQL injection, XSS, or other security issues

**In focused/deep mode**, also read the relevant component files for the targeted directory:
- `apps/web/src/app/(directories)/<directory>/` — page components
- `apps/web/src/components/entities/` — entity-specific components
- `apps/web/src/data/entity-schemas.ts` — schema definitions

### 2e. Wiki-server route audit

Launch an agent to read wiki-server routes and check for:
- Unbounded queries (no LIMIT)
- Missing input validation
- N+1 query patterns
- Inconsistent response shapes

**Skip this phase in focused quick/standard mode** unless the focus area involves server-side data.

## Phase 3: Compile findings

Wait for all agents to complete. Compile a deduplicated, prioritized report:

```
## QA Sweep — [DATE]
### Focus: [directory name or "full sweep"] | Depth: [quick/standard/deep/exhaustive]
### Agents launched: N | Pages checked: N

### P0 — Active bugs (user-visible now)
[Table: #, Bug, URL or File:Line, Fix]

### P1 — Latent bugs (will surface under conditions)
[Table: #, Bug, URL or File:Line]

### P2 — UX improvements
[Table: #, Issue, URL or Location]

### Data completeness
[Per-column fill rates for each index page checked]

### Cross-consistency issues (deep/exhaustive only)
[Table: #, Mismatch, Page A, Page B]

### Confirmed clean
[Bullet list of areas checked and found clean]
```

## Phase 4: Act on findings

| Severity | Action |
|----------|--------|
| **P0** (active bug) | Fix it now in a branch, open a PR |
| **P1** (latent bug) | File a GitHub issue with `pnpm crux issues create` |
| **P2** (quality/UX) | File an issue if actionable, otherwise note in report |

After fixing P0s, run `/push-and-ensure-green` to ship.

## Guardrails

- **Do not fix P1/P2 issues during the sweep** unless they are one-line changes. File issues instead.
- **Evidence over impressions.** Every finding must reference a specific file, line, or URL.
- **Limit scope.** If you find >30 issues, report the top 15 by severity and batch the rest into an umbrella issue.
- **No false positives.** Only report issues you have confirmed by fetching the actual page or reading the actual code.
- **Prioritize recent changes.** Areas changed in the last 48 hours get 3x the attention.
- **Time box.** Quick: ~5 min. Standard: ~10 min. Deep: ~30 min. Exhaustive: ~60 min.
- **Parallelize aggressively.** Launch all independent agents in a single message. The subscription model means agent count is free — use it.
