# Codebase Audit

Strategic review of codebase health, complexity trends, and simplification opportunities. Produces a written report with concrete recommendations.

**Recommended cadence:** Biweekly, or after a burst of infrastructure PRs.

**Relationship to `/maintain`:** `/maintain` handles day-to-day cleanup (close issues, fix cruft, propagate learnings). `/audit` is the strategic counterpart — it asks whether systems are earning their complexity and whether the overall trajectory is healthy.

## Phase 1: Measure

Gather quantitative signals. Run all of these — the report needs hard numbers, not impressions.

```bash
# Health metrics snapshot
pnpm crux maintain health-snapshot --json

# Cruft detection
pnpm crux maintain detect-cruft

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

### 2a. Complexity hotspots

Identify the 5 largest directories/files by line count. For each, ask:
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

### 2c. Overlap and duplication

Look for systems that partially overlap:
- Multiple solutions to the same problem (e.g., two ways to track agent status)
- Features that could be consolidated into one
- Defensive checks that duplicate what another check already catches

### 2d. Documentation staleness

Quickly scan these files for accuracy:
- `CLAUDE.md` — do the commands still work? Are the conventions current?
- `.claude/rules/*.md` — any rules that reference removed systems?
- `README.md` files in key directories — still accurate?
- `content/docs/internal/*.mdx` — any internal docs referencing old patterns?

Don't fix documentation here — just note what's stale for the report.

### 2e. Dead code signals

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

### Key Metrics
- Total lines (TS/TSX/MJS): X
- Net growth last 14 days: +/- X
- GitHub Actions workflows: X
- Internal dashboards: X
- Health snapshot score: [paste key metrics]

### Top Complexity Hotspots
[Top 5 largest directories/files with size, churn, and assessment]

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
- **Medium items**: File a GitHub issue with the evidence from the report (`pnpm crux issues create`)
- **Architectural decisions**: Note them for the user to discuss — don't file issues for things that need human judgment

## Guardrails

- **Do not remove code during the audit.** The audit produces a report and files issues. Removal happens in separate, focused PRs.
- **Evidence over impressions.** Every claim in the report should reference a file path, line count, or command output.
- **Compare to value, not to zero.** A 1,000-line system that prevents real bugs is fine. A 200-line system that solves a hypothetical problem is not.
- **Content pages are the product.** Infrastructure exists to serve wiki content. If infrastructure is growing faster than content, flag it prominently.
