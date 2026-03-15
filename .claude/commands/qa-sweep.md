# Adversarial QA Sweep

$ARGUMENTS

Systematic adversarial audit of the wiki. Finds bugs, broken pages, regressions, and data integrity issues. Produces a prioritized findings report and files GitHub issues for real bugs.

**Schedule:** `/loop 24h /qa-sweep` for daily runs using your Claude Code subscription.

**Modes:**
- `/qa-sweep` — broad sweep across the whole site (default)
- `/qa-sweep red-team the safety approaches table` — focused audit on a specific area
- `/qa-sweep check all links on the grants pages` — targeted investigation

**How it works:**
1. Check if `$ARGUMENTS` specifies a focus area (see "Focus mode" below)
2. `pnpm crux qa-sweep` runs deterministic checks (duplicate IDs, broken refs, tests, gate)
3. This skill adds LLM-driven agents on top (production site audit, code review of recent changes)
4. Findings are compiled into a P0/P1/P2 report
5. P0 bugs get fixed; P1/P2 get filed as GitHub issues

**Relationship to other commands:**
- `/maintain` — day-to-day cleanup (close issues, fix cruft)
- `/audit` — strategic review (complexity trends, architecture)
- `/qa-sweep` — adversarial (actively try to break things)

## Focus mode

If `$ARGUMENTS` is non-empty, this is a **focused sweep**. Instead of the broad Phase 2 audits below, concentrate all agents on the specified target:

1. **Interpret the request.** Parse `$ARGUMENTS` to determine what area, page, feature, or component to audit.
2. **Find the relevant code.** Use Explore agents to locate all files related to the target (pages, components, data files, routes, tests).
3. **Run targeted checks.** Launch **5-8 agents** in parallel, each attacking the target from a different angle. Be thorough — read every relevant file, not just a sample:
   - **Data integrity**: Are the facts correct? Do numbers match across tables and prose? Are entity references valid? Cross-check against source URLs where possible.
   - **UI/UX**: Fetch the actual production page with WebFetch. Is the table populated? Links working? Layout issues? Try multiple pages in the area, not just one.
   - **Code quality**: Read every component, hook, and utility involved. Logic errors, null safety, error handling, type safety? Trace the full data flow from source to render.
   - **Edge cases**: What happens with empty data, missing fields, very long values, special characters? Check the actual data for these cases.
   - **Cross-references**: Do other pages that link to this area have consistent information? Check at least 5-10 cross-references.
   - **Data completeness**: Are there entities/rows with missing fields that should have data? Scan the full dataset, not a sample.
   - **Stale content**: Are dates, roles, statuses current? Check against external sources if accessible.
4. **Skip Phase 1** (`crux qa-sweep`) if the focus is narrow enough that the broad checks aren't relevant. Use your judgment.
5. **Proceed to Phase 3** (compile findings) and **Phase 4** (act) as normal.

If `$ARGUMENTS` is empty, proceed with the standard broad sweep below.

## Phase 1: Deterministic checks

Run the crux command to get automated check results and recent change context:

```bash
pnpm crux qa-sweep
```

Read the output. Note:
- Which checks failed or warned
- Which areas had the most recent changes (these get priority in Phase 2)

## Phase 2: LLM-driven audits (broad sweep)

Launch these **in parallel** using the Agent tool. Each agent is research-only (no code changes). Focus agents on areas flagged in Phase 1.

**Depth over breadth.** Each agent should be thorough: read every file it touches fully, follow import chains, check actual data values. A shallow scan of 50 files is less valuable than a deep audit of 10.

### 2a. Production site audit

Launch an agent to fetch key pages from `https://www.longtermwiki.com` using WebFetch:

**Pages to check:** `/wiki`, `/people`, `/organizations`, `/risks`, `/legislation`, `/grants`, `/publications`, `/ai-models`, `/benchmarks`, `/internal/entities`, `/internal/things`, plus 5-10 random wiki pages (`/wiki/E<random>`).

For each page, check:
- Does it load (not 404/500)?
- Is the table populated or empty?
- Any visible error messages or raw HTML/MDX?
- Do stats match table content?
- Do links within the page work? (spot-check 3-5 internal links per page)
- Is data plausible? (e.g. org founded dates aren't in the future, funding amounts aren't negative)

### 2b. Code quality audit (split into 2-3 agents by area)

Don't lump all code review into one agent. Split by area (e.g. one agent for app/ components, one for data layer, one for crux/). For each, **read the full file** — not just the diff — and check for:
- Logic errors, off-by-one, null safety
- Silent error swallowing (`.catch(() => {})`)
- Type safety issues (`as any`, `as unknown as T`)
- Broken imports or stale references
- Missing `"use client"` directives
- SQL injection, XSS, or other security issues
- Dead code paths (functions/exports never imported anywhere)
- Data transformation bugs (wrong field names, missing null checks in maps/filters)

### 2c. Data consistency audit

Launch an agent to cross-check data integrity:
- Sample 20-30 entities and verify their YAML data matches their MDX page content
- Check that entity links in MDX pages point to entities that actually exist
- Verify numericIds are consistent between YAML and MDX frontmatter
- Check for orphaned data (entities with no page, pages with no entity)

### 2d. Wiki-server route audit

Launch an agent to read wiki-server routes and check for:
- Unbounded queries (no LIMIT)
- Missing input validation
- N+1 query patterns
- Inconsistent response shapes
- Error responses that leak internal details

## Phase 3: Compile findings

Wait for all agents to complete. Compile a deduplicated, prioritized report:

```
## QA Sweep — [DATE]

### P0 — Active bugs (user-visible now)
[Table: #, Bug, File:Line, Fix]

### P1 — Latent bugs (will surface under conditions)
[Table: #, Bug, File:Line]

### P2 — Code quality / performance
[Table: #, Issue, Location]

### Confirmed clean
[Bullet list of areas checked and found clean]
```

## Phase 4: Log results

Post the compiled report as a comment on **GitHub issue #2400** (QA Sweep Log):

```bash
gh issue comment 2400 --body "$(cat <<'SWEEPEOF'
## QA Sweep — [DATE] ([trigger: manual/loop])

**Branch**: `[current branch]`

### Scorecard
| Check | Status | Count |
|-------|--------|-------|
| Duplicate numericIds | ✓/⚠/✗ | N |
| ... | ... | ... |

### P0 — Active bugs
[numbered list]

### P1 — Latent bugs
[numbered list]

### P2 — Code quality
[numbered list]

### Confirmed clean
[bullet list]
SWEEPEOF
)"
```

This builds a running history on #2400 that an LLM can review later to spot trends.

## Phase 5: Act on findings

| Severity | Action |
|----------|--------|
| **P0** (active bug) | Fix it now in a branch, open a PR |
| **P1** (latent bug) | File a GitHub issue with `pnpm crux issues create` |
| **P2** (quality) | File an issue if actionable, otherwise note in report |

After fixing P0s, run `/push-and-ensure-green` to ship.

## Guardrails

- **Do not fix P1/P2 issues during the sweep** unless they are one-line changes. File issues instead.
- **Evidence over impressions.** Every finding must reference a specific file, line, or URL.
- **No false positives.** Only report issues you have confirmed. But don't let fear of false positives make you too conservative — if something looks wrong, investigate it thoroughly rather than skipping it.
- **Prioritize recent changes.** Areas changed in the last 48 hours get 3x the attention.
- **Be thorough, not fast.** A sweep that takes 45 minutes and finds 8 real bugs is more valuable than one that takes 10 minutes and finds 1. Do not rush. Read full files. Follow import chains. Check actual data values. When an agent reports back, evaluate whether it was genuinely thorough — if it checked 3 files and said "looks fine," send it back with more specific instructions.
- **Report everything you find.** Do not artificially limit to "top 10." If you find 25 issues, report all 25. Group by severity but don't drop findings.
