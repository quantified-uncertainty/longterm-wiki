---
description: Systematic adversarial audit of the wiki — finds bugs, broken pages, regressions, data integrity issues.
argument-hint: "[directories] [--depth=quick|standard|deep|exhaustive]"
effort: medium
---

# Adversarial QA Sweep

Systematic adversarial audit of the wiki. Finds bugs, broken pages, regressions, and data integrity issues. Produces a prioritized findings report and files Linear issues for real bugs.

**Schedule:** `/loop 24h /maintain-qa-sweep` for daily runs using your Claude Code subscription.

**Usage:**
- `/maintain-qa-sweep` — standard sweep across all directories (~10 min)
- `/maintain-qa-sweep legislation` — focus on one directory
- `/maintain-qa-sweep organizations,people` — focus on multiple directories
- `/maintain-qa-sweep --pages=/organizations/1day-sooner,/legislation/eu-ai-act` — specific URLs
- `/maintain-qa-sweep --depth=deep` — thorough audit with many subagents (~30 min)
- `/maintain-qa-sweep --depth=exhaustive` — maximum coverage, every directory + detail pages (~60 min)
- `/maintain-qa-sweep legislation --depth=deep` — deep audit of one directory

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
4. P0 bugs get fixed; P1/P2 get filed as Linear issues

**Relationship to other commands:**
- `/maintain` — day-to-day cleanup (close issues, fix cruft)
- `/maintain-audit` — strategic review (complexity trends, architecture)
- `/maintain-qa-sweep` — adversarial (actively try to break things)

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
| `funding-programs` | `/funding-programs` | — | `/funding-programs/<slug>` |
| `funding-rounds` | `/funding-rounds` | — | `/funding-rounds/<id>` |
| `divisions` | `/divisions` | — | `/divisions/<slug>` |

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

## Phase 1.5: Parse deterministic results and extract leads

Run the deep deterministic sweep with JSON output to get structured findings:

```bash
pnpm crux qa-sweep deep --json
```

Parse the JSON output and extract leads by category. Store these leads — they will be injected directly into agent prompts in Phase 2.

**Lead routing by finding type:**

| Finding type | Route to | Example |
|---|---|---|
| `yaml_field_consistency` / `relatedEntry` type mismatches | Cross-consistency agent | Which specific entity IDs have mismatched `relatedEntry` types |
| `people_role_mismatches` | People agent | Which specific people have conflicting role/affiliation data |
| `broken_internal_links` | Code agent | Which specific files have broken internal links |
| `financial_staleness` | Financial agent | Which specific entity slugs have stale funding data |
| `schema_violations` | Code agent | Which entity types have invalid YAML field values |
| `duplicate_ids` | Code agent | Which IDs appear more than once across files |
| `orphaned_references` | Cross-consistency agent | Which references point to nonexistent targets |

If `pnpm crux qa-sweep deep --json` fails or returns no leads (command not yet implemented), fall back to running `pnpm crux qa-sweep` and treating the plain-text output as unstructured context to pass to agents.

**After extracting leads:**
- Group leads by the agent type that should receive them
- Format each group as a concise bullet list: entity ID, file path, and the specific discrepancy found
- If a lead category is empty, that agent still runs but without targeted context

## Phase 2: LLM-driven audits

Launch agents **in parallel** using the Agent tool. Each agent is research-only (no code changes).

**Agent strategy by depth:**

All depths now use a **leads-driven** approach: deterministic findings from Phase 1.5 are injected into agent prompts as specific targets. This replaces blind directory exploration at lower depths.

### Quick depth
- **1 leads agent**: given all deterministic leads, verify each finding (confirm or refute). No broad exploration.
- 1 agent: code quality on recently changed files only (from Phase 1 output)
- 1 agent: wiki-server route audit (focused on routes touched by recent commits)

No broad index-page fetching at this depth — the deterministic leads are the entire scope.

### Standard depth
- **1 leads agent**: given all deterministic leads from Phase 1.5, verify each finding in detail
- 1 agent per focused directory (or 1 agent for all index pages if unfocused), seeded with any relevant leads for that directory
- 1 agent: detail page sampling (3-5 pages per focused directory), prioritizing pages flagged in leads
- 1 agent: code quality on recent changes
- 1 agent: wiki-server route audit

### Deep depth
- **1 leads verification agent**: works through the full deterministic lead list systematically
- **1 agent per directory**: each fetches the index page + 10-15 detail pages within that directory, **starting with pages named in the leads**
- **1 cross-consistency agent**: given any cross-entity leads from Phase 1.5, plus its own checks that data matches across directories (e.g., org page funding total matches grants page, person affiliations match org people tabs)
- **1 agent per audit type**: code quality, wiki-server routes
- **1 component code agent**: reads the actual React components for focused directories, checks for bugs in rendering logic

### Exhaustive depth
- **1 agent per directory** (same as deep, but samples ALL detail pages in batches of 10)
- **2-3 cross-consistency agents**: one for financial data, one for people/org links, one for dates/timelines — each seeded with relevant leads
- **1 agent per audit type**: code quality, wiki-server routes, schema validation
- **1 component code agent per directory**: reads rendering components
- **1 accessibility agent**: checks for alt text, ARIA labels, keyboard navigation
- **1 stale data agent**: checks for outdated dates, dead external links, references to old events

### Leads-driven agent prompt template

When launching any agent that has deterministic leads assigned to it, prepend the following to the agent's task:

```
The deterministic sweep found these specific issues for you to investigate:

[paste the relevant leads here as a bullet list, e.g.:]
- Entity E042 (openai): relatedEntry "E099" typed as "organization" but target is type "person"
- Entity E107 (sam-altman): role listed as "CEO" on people page but "board member" in org people tab
- File apps/web/src/components/entities/org-card.tsx line 84: link to /organizations/nonexistent-slug

For each finding:
1. Fetch or read the relevant page/file to confirm or refute
2. If confirmed: note the exact discrepancy with URLs/line numbers
3. If refuted: note what you found instead (the deterministic check may be stale)
4. If needs more context: fetch additional related pages and document what you found

After working through the leads, [continue with your normal exploration task below...]
```

If no leads were extracted for a particular agent, omit the leads block entirely and run the normal exploration task.

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

```markdown
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

## Phase 4: Record results, file issues, and persist the report

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

- **File one Linear issue per finding** (P0, P1, and P2). Do not batch unrelated issues into umbrella issues.
- Closely related findings (e.g., 5 entities with the same data problem) may be grouped into one issue.
- Use `pnpm crux linear create "title" --description="..."` for each.
- **Expected volume:** 5-15 issues per deep sweep is normal.
- **Do NOT skip P1 and P2 filing.** Every confirmed finding must become a Linear issue. If you compiled it into the report, file it.

### Persist the full report to a GitHub Discussion

After filing issues, post the **complete** Phase 3 report as a comment on **Discussion #2650** (the canonical "QA Sweep Reports" archive). Always use #2650 — do **not** create a new discussion. Past attempts to "find or create" the discussion produced duplicates (#3220, #3724) which were closed in favor of #2650.

```bash
# Always post to #2650 — do not create a new discussion
pnpm crux gh epic comment 2650 "$(cat <<'REPORT'
## QA Sweep — [DATE]
### Focus: [focus] | Depth: [depth]
[Full report here — copy the entire Phase 3 output]

### Issues filed
- #N: title
- #N: title
...
REPORT
)"
```

If #2650 has been closed or replaced for some reason (verify by running `pnpm crux gh epic view 2650`), stop and ask the user — do **not** silently create a new discussion.

### Fix P0s

| Severity | Action |
|----------|--------|
| **P0** (active bug) | Fix it now in a branch, open a PR |
| **P1** (latent bug) | File a Linear issue (already done above) |
| **P2** (quality/UX) | File a Linear issue (already done above) |

After fixing P0s, run `/agent-push-and-verify` to ship.

## Guardrails

- **Do not fix P1/P2 issues during the sweep** unless they are one-line changes. File issues instead.
- **Evidence over impressions.** Every finding must reference a specific file, line, or URL.
- **No false positives.** Only report issues you have confirmed by fetching the actual page or reading the actual code.
- **Prioritize recent changes.** Areas changed in the last 48 hours get 3x the attention.
- **Time box.** Quick: ~5 min. Standard: ~10 min. Deep: ~30 min. Exhaustive: ~60 min.
- **Parallelize aggressively.** Launch all independent agents in a single message. The subscription model means agent count is free — use it.
- **File generously.** If you found it and confirmed it, file it. Do not leave confirmed issues unfiled just because they're P2.
