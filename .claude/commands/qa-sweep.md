# Adversarial QA Sweep

Systematic adversarial audit of the wiki. Finds bugs, broken pages, regressions, and data integrity issues. Produces a prioritized findings report and files GitHub issues for real bugs.

**Schedule:** `/loop 24h /qa-sweep` for daily runs using your Claude Code subscription.

**How it works:**
1. `pnpm crux qa-sweep` runs deterministic checks (duplicate IDs, broken refs, tests, gate)
2. This skill adds LLM-driven agents on top (production site audit, code review of recent changes)
3. Findings are compiled into a P0/P1/P2 report
4. P0 bugs get fixed; P1/P2 get filed as GitHub issues

**Relationship to other commands:**
- `/maintain` — day-to-day cleanup (close issues, fix cruft)
- `/audit` — strategic review (complexity trends, architecture)
- `/qa-sweep` — adversarial (actively try to break things)

## Phase 1: Deterministic checks

Run the crux command to get automated check results and recent change context:

```bash
pnpm crux qa-sweep
```

Read the output. Note:
- Which checks failed or warned
- Which areas had the most recent changes (these get priority in Phase 2)

## Phase 2: LLM-driven audits

Launch these **in parallel** using the Agent tool. Each agent is research-only (no code changes). Focus agents on areas flagged in Phase 1.

### 2a. Production site audit

Launch an agent to fetch key pages from `https://www.longtermwiki.com` using WebFetch:

**Pages to check:** `/wiki`, `/people`, `/organizations`, `/risks`, `/legislation`, `/grants`, `/publications`, `/ai-models`, `/benchmarks`, `/internal/entities`, `/internal/things`, plus 3-5 random wiki pages (`/wiki/E<random>`).

For each page, check:
- Does it load (not 404/500)?
- Is the table populated or empty?
- Any visible error messages or raw HTML/MDX?
- Do stats match table content?

### 2b. Code quality audit

Launch an agent to read recently changed files (from Phase 1 output) and check for:
- Logic errors, off-by-one, null safety
- Silent error swallowing (`.catch(() => {})`)
- Type safety issues (`as any`, `as unknown as T`)
- Broken imports or stale references
- Missing `"use client"` directives
- SQL injection, XSS, or other security issues

### 2c. Wiki-server route audit

Launch an agent to read wiki-server routes and check for:
- Unbounded queries (no LIMIT)
- Missing input validation
- N+1 query patterns
- Inconsistent response shapes

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

## Phase 4: Act on findings

| Severity | Action |
|----------|--------|
| **P0** (active bug) | Fix it now in a branch, open a PR |
| **P1** (latent bug) | File a GitHub issue with `pnpm crux issues create` |
| **P2** (quality) | File an issue if actionable, otherwise note in report |

After fixing P0s, run `/push-and-ensure-green` to ship.

## Guardrails

- **Do not fix P1/P2 issues during the sweep** unless they are one-line changes. File issues instead.
- **Evidence over impressions.** Every finding must reference a specific file, line, or URL.
- **Limit scope.** If you find >15 issues, report the top 10 by severity and batch the rest.
- **No false positives.** Only report issues you have confirmed.
- **Prioritize recent changes.** Areas changed in the last 48 hours get 3x the attention.
- **Time box.** The full sweep should complete in under 15 minutes.
