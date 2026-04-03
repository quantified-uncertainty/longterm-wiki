---
description: Strategic review of codebase health, complexity trends, and simplification opportunities.
effort: medium
---

# Codebase Audit

Strategic review of codebase health, complexity trends, and simplification opportunities. Scopes analysis to recently-merged PRs so findings target code with active churn — where cleanup has the highest ROI. Produces a written report with concrete recommendations.

**Usage:**
- `/maintain-audit` — default 60-hour lookback
- `/maintain-audit 7d` — 7-day lookback
- `/maintain-audit 14d` — 14-day lookback

**Recommended cadence:** Biweekly, or after a burst of infrastructure PRs.

**Relationship to `/maintain`:** `/maintain` handles day-to-day cleanup (close issues, fix cruft, propagate learnings). `/maintain-audit` is the strategic counterpart — it asks whether systems are earning their complexity and whether the overall trajectory is healthy. It uses recent PRs as the scoping lens to find fix chains, incomplete migrations, and duplication introduced by recent work.

## Phase 0: Scope from Recent PRs

Before measuring the whole codebase, use recent PRs as a **scoping lens**. This focuses the audit on areas with active churn — where cleanup has the highest ROI.

**Default lookback:** 60 hours. Adjust with `$ARGUMENTS` (e.g., `/maintain-audit 7d`, `/maintain-audit 14d`).

```bash
# Parse lookback from arguments (default: 60 hours)
# Accepts: "60h", "3d", "7d", "14d" — or empty for default

# List merged PRs in the lookback window (exclude release/bot PRs)
gh pr list -R quantified-uncertainty/longterm-wiki --state merged --limit 80 \
  --json number,title,mergedAt,additions,deletions,author \
  --jq '[.[] | select(.author.is_bot == false)] | sort_by(.mergedAt) | reverse | .[] | "\(.number)\t+\(.additions)/-\(.deletions)\t\(.title)"'

# Collect all files changed across those PRs
gh pr list -R quantified-uncertainty/longterm-wiki --state merged --limit 80 \
  --json number,mergedAt,author,files \
  --jq '[.[] | select(.author.is_bot == false)] | [.[].files[].path] | unique | sort | .[]' \
  > /tmp/audit-changed-files.txt
wc -l < /tmp/audit-changed-files.txt
echo "---"
# Show file change frequency (most-touched files = highest cleanup ROI)
gh pr list -R quantified-uncertainty/longterm-wiki --state merged --limit 80 \
  --json number,mergedAt,author,files \
  --jq '[.[] | select(.author.is_bot == false)] | [.[].files[].path] | group_by(.) | map({file: .[0], count: length}) | sort_by(.count) | reverse | .[:20] | .[] | "\(.count)\t\(.file)"'
```

Read the output. This gives you:
1. **PR list**: What was shipped and how big each PR was
2. **Changed file list**: The full set of files touched — this scopes Phase 2 analysis
3. **Hot files**: Files touched by multiple PRs — prime candidates for duplication, complexity, or incomplete refactoring

**Identify fix chains**: Look for patterns where a feature PR was followed by 1+ fix PRs touching the same files. These indicate the original PR shipped incomplete and the affected code likely needs further cleanup.

Save the changed files list — you will use it in Phase 2 to focus your analysis on recently-touched code rather than auditing the entire codebase.

## Phase 1: Measure

Gather quantitative signals. Run all of these — the report needs hard numbers, not impressions.

```bash
# Health metrics snapshot
pnpm crux sys maintain health-snapshot --json

# Cruft detection
pnpm crux sys maintain detect-cruft

# Code size by top-level directory (quick proxy for complexity distribution)
find . -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' | grep -v node_modules | grep -v .next | xargs wc -l | sort -rn | head -40

# Unused exports and dead code (if knip is available)
npx knip --reporter compact 2>/dev/null || echo "knip not configured — skip"

# Recent growth: lines added/removed in last 14 days
git log --since="14 days ago" --pretty=tformat: --numstat | awk '{ add += $1; del += $2 } END { printf "Added: %d  Removed: %d  Net: %d\n", add, del, add-del }'

# File count trend
echo "Total TS/TSX/MJS files:"; find . -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' | grep -v node_modules | grep -v .next | wc -l

# GitHub Actions workflow count
ls -1 .github/workflows/*.yml 2>/dev/null | wc -l

# Internal dashboard count
ls -1 apps/web/src/app/internal/ 2>/dev/null | wc -l
```

Read the output of each command. Note the numbers — you will reference them in the report.

## Phase 2: Analyze

With the numbers in hand, investigate these questions. Use Grep, Glob, and Read tools to gather evidence. Do NOT guess — find the actual code.

**Use the Phase 0 file list to focus your analysis.** For each section below, prioritize files that appear in `/tmp/audit-changed-files.txt`. Files not touched by recent PRs can be noted but should not dominate the report — the goal is to find cleanup opportunities in recently-shipped code.

### 2a. Complexity hotspots

Identify the 5 largest recently-changed files by line count (cross-reference with Phase 0 hot files). For each, ask:
- Is this size justified by what it does?
- Could it be split, simplified, or partially removed?
- How often is it modified? (Use `git log --oneline --since="30 days ago" -- <path> | wc -l`)

### 2b. Systems earning their keep

For each major infrastructure system (groundskeeper, active-agents, agent-checklist, semantic-diff, rate-limiter, etc.), evaluate:
- **Size**: How many lines of production code + test code?
- **Usage**: Is it actually called/checked by other systems? Grep for imports.
- **Recent churn**: How many PRs touched it in the last 30 days? High churn on infrastructure = red flag.
- **Value delivered**: What concrete problem does it solve? Is there a simpler alternative?

Flag any system where test code exceeds production code by more than 2:1 — this often indicates over-engineering.

### 2c. PR-driven duplication and incomplete refactoring

Using the Phase 0 PR list, look specifically for:

**Fix chains**: Where a feature PR was followed by 1+ fix PRs. Read the fix PRs to understand what broke — the underlying code likely needs further cleanup beyond the point fix. Common patterns:
- Import breakage after a migration PR (incomplete migration)
- Type errors from hand-written types drifting from actual shapes
- Build failures from stale references after a rename/restructure

**Duplication introduced by recent PRs**: Read the hot files from Phase 0. Check for:
- Near-identical functions or type definitions added in different PRs (e.g., the same hash function in 4 files, the same interface defined in frontend and CLI)
- Copy-pasted patterns that should be a shared utility
- Hand-written types that duplicate what Hono RPC inference would provide

**Incomplete migrations**: When a PR partially migrates a pattern (e.g., moves 36 of 100 calls from old API to new), check the current state — how many remain? Is the old pattern still growing? Should the gate check be made blocking?

### 2d. Overlap and duplication

Look for systems that partially overlap:
- Multiple solutions to the same problem (e.g., two ways to track agent status)
- Features that could be consolidated into one
- Defensive checks that duplicate what another check already catches

### 2e. Documentation staleness

Quickly scan these files for accuracy:
- `CLAUDE.md` — do the commands still work? Are the conventions current?
- `.claude/rules/*.md` — any rules that reference removed systems?
- `README.md` files in key directories — still accurate?
- `content/docs/internal/*.mdx` — any internal docs referencing old patterns?

Don't fix documentation here — just note what's stale for the report.

### 2f. Dead code signals

Look for:
- Exported functions/types with zero importers (knip output, or manual grep)
- Feature flags or config options that are always set to the same value
- Commented-out code blocks (detect-cruft output)
- Files that haven't been modified in 90+ days in fast-moving directories

## Phase 3: Write the Report

Produce a structured report. Be specific and evidence-based — include line counts, file paths, and PR numbers. The report should be actionable by someone who hasn't read the codebase recently.

### Report structure

```
## Codebase Audit — [DATE]
### Lookback: [N] hours | PRs reviewed: [N] | Files changed: [N]

### Key Metrics
- Total lines (TS/TSX/MJS): X
- Net growth last 14 days: +/- X
- GitHub Actions workflows: X
- Internal dashboards: X
- Health snapshot score: [paste key metrics]

### Recent PR Summary
- PRs in window: X (features: Y, fixes: Z, refactors: W)
- Fix chains: [list each: Feature PR → Fix 1 → Fix 2]
- Hot files (touched by 3+ PRs): [list]
- Largest PRs: [top 3 by additions]

### PR-Driven Cleanup Opportunities
[Findings from Phase 2c — duplication, incomplete migrations, fix chain root causes]
[For each: specific files, what to consolidate, estimated effort]

### Top Complexity Hotspots
[Top 5 largest recently-changed files with size, churn, and assessment]

### Systems Review
[For each major system: size, usage, churn, verdict (keep/simplify/remove)]

### Overlap & Consolidation Opportunities
[Specific pairs/groups of systems that overlap]

### Documentation Issues
[List of stale docs with what's wrong]

### Dead Code Candidates
[Specific exports, files, or features that appear unused]

### Recommended Actions
[Prioritized list: what to do, estimated effort, expected impact]
- Tier 1 (safe, do now): ...
- Tier 2 (needs discussion): ...
- Tier 3 (architectural decision): ...
```

## Phase 4: Act or File

For each recommendation:
- **Quick wins** (< 30 min, safe): Do them in this session if time allows
- **Medium items**: File a GitHub issue with the evidence from the report (`pnpm crux gh issues create`)
- **Architectural decisions**: Note them for the user to discuss — don't file issues for things that need human judgment

## Guardrails

- **Do not remove code during the audit.** The audit produces a report and files issues. Removal happens in separate, focused PRs.
- **Evidence over impressions.** Every claim in the report should reference a file path, line count, or command output.
- **Compare to value, not to zero.** A 1,000-line system that prevents real bugs is fine. A 200-line system that solves a hypothetical problem is not.
- **Content pages are the product.** Infrastructure exists to serve wiki content. If infrastructure is growing faster than content, flag it prominently.
