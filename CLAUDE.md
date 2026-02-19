# Longterm Wiki - Claude Code Config

AI safety wiki with ~625 MDX pages, Next.js frontend, YAML data layer, and CLI tooling.

**Keep CLAUDE.md as a routing document** — brief instructions and pointers to detailed guides. Detailed style guidance, checklists, and templates live in `content/docs/internal/` (see Page templates below). Do not expand CLAUDE.md with long explanations; instead add detail to the appropriate internal style guide and reference it from here.

## MANDATORY FIRST ACTION — Do this before anything else

Before reading files, running commands, or writing any code, run:

```bash
pnpm crux agent-checklist init --issue=N   # if working on a GitHub issue
# or
pnpm crux agent-checklist init "Task description" --type=X   # if not on an issue
```

**"Before writing code" is not good enough** — quick fixes, research, and file reads all count. If you skip this and dive straight in, you will forget it entirely. Run it first, then proceed.

See `## Agent Session Workflow — MANDATORY` below and `.claude/rules/agent-session-workflow.md` for full details.

## Quick Reference

```bash
# First-time setup
pnpm setup                       # Full setup: install, build data, validate
pnpm setup:quick                 # Install + build data only (skip validation)
pnpm setup:check                 # Check environment without changing anything

# Development
pnpm dev                         # Start dev server on port 3001
pnpm build                      # Production build (runs assign-ids + build-data automatically)

# Numeric ID assignment (issue #245)
node app/scripts/assign-ids.mjs              # Assign numericIds to new entities/pages
node app/scripts/assign-ids.mjs --dry-run    # Preview assignments without writing files

# Testing
pnpm test                        # Run vitest tests

# Pre-push gate (CI-blocking checks)
pnpm crux validate gate          # Build data + tests + blocking validations
pnpm crux validate gate --full   # Also runs full Next.js build

# Tooling (Crux CLI)
pnpm crux validate               # Run all validation checks
pnpm crux --help                 # Show all CLI domains
pnpm crux content improve <id>   # Improve a wiki page
pnpm crux edit-log view <id>     # View edit history for a page
pnpm crux maintain               # Run maintenance sweep (PRs, issues, cruft)
pnpm crux maintain status        # Check when maintenance last ran

# Agent checklists
pnpm crux agent-checklist init "Task" --type=X    # Generate typed checklist
pnpm crux agent-checklist init --issue=N          # Auto-detect type from issue labels
pnpm crux agent-checklist check <id> [id2...]     # Check off items by ID
pnpm crux agent-checklist check --na <id>         # Mark items as N/A
pnpm crux agent-checklist verify                  # Auto-verify items with verifyCommand
pnpm crux agent-checklist status                  # Show checklist progress
pnpm crux agent-checklist complete                # Validate all items checked
pnpm crux agent-checklist snapshot                # Output checks: YAML block for session log

# GitHub issue tracking
pnpm crux issues                 # List open issues ranked by priority
pnpm crux issues next            # Show next highest-priority issue to work on
pnpm crux issues start <N>       # Signal start: comment + add claude-working label
pnpm crux issues done <N>        # Signal completion: comment + remove label

# Hallucination risk & review tracking
pnpm crux validate hallucination-risk         # Risk assessment report
pnpm crux validate hallucination-risk --top=20  # Top 20 highest-risk pages
pnpm crux review mark <id> --reviewer="name"  # Mark page as human-reviewed
pnpm crux review list                         # List reviewed pages

# Session log validation
pnpm crux validate session-logs              # Check session log format/fields
pnpm crux validate session-logs --ci         # JSON output for CI

# Citation verification & archival
pnpm crux citations verify <id>              # Verify all citations on a page
pnpm crux citations verify --all --limit=20  # Verify top 20 pages with citations
pnpm crux citations status <id>              # Show verification results for a page
pnpm crux citations report                   # Summary across all archived pages
pnpm crux citations report --broken          # List all broken citations

# Citation quote extraction & verification
pnpm crux citations extract-quotes <id>              # Extract supporting quotes for a page
pnpm crux citations extract-quotes --all --limit=10  # Batch extract quotes
pnpm crux citations quote-report                     # Quote coverage statistics
pnpm crux citations quote-report --broken            # Show broken/drifted quotes
pnpm crux citations verify-quotes <id>               # Re-verify stored quotes
pnpm crux citations verify-quotes --all              # Re-verify all stored quotes
```

## Repository Structure

```
longterm-wiki/
├── content/docs/               # ~625 MDX wiki pages
├── data/                       # YAML source data (entities, facts, resources, etc.)
│   ├── entities/               # Entity YAML definitions
│   ├── facts/                  # Canonical facts
│   ├── resources/              # External resource links
│   ├── insights/               # Cross-page insights
│   ├── graphs/                 # Cause-effect graph data
│   ├── edit-logs/              # Per-page edit history (YAML, auto-maintained)
│   └── id-registry.json        # Derived build artifact (gitignored)
├── app/                        # Next.js 15 frontend
│   ├── src/                    # App source code
│   ├── scripts/                # Build scripts (build-data.mjs)
│   └── package.json            # App dependencies
├── crux/                       # Crux CLI + validation (see crux/README.md)
│   ├── crux.mjs                # CLI entry point
│   ├── commands/               # CLI domain handlers
│   ├── authoring/              # Page authoring scripts (create, improve, grade)
│   ├── lib/                    # Shared utilities, validation rules, page templates
│   └── validate/               # Validation scripts
└── package.json                # Workspace root
```

## Data Flow

1. YAML files in `data/` define entities, facts, resources
2. `app/scripts/build-data.mjs` transforms YAML + MDX frontmatter → `database.json`
3. Next.js app reads `database.json` at build time
4. MDX pages in `content/docs/` are compiled via next-mdx-remote

## Page Authoring Workflow

When creating or editing wiki pages, **always use the Crux content pipeline**. Do not manually write wiki pages from scratch.

### Prerequisites

If `app/src/data/pages.json` doesn't exist, generate it first:
```bash
node app/scripts/build-data.mjs
```

### Creating a new page
```bash
pnpm crux content create "Page Title" --tier=standard
```
Tiers: `budget` (~$2-3), `standard` (default, ~$4-6), `premium` (~$8-12)

**API keys are in environment variables** (`process.env`), NOT in `.env` files. Check `env | grep -i API` to verify available keys before assuming they're missing. Required keys: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`. Optional: `FIRECRAWL_KEY`, `SCRY_API_KEY`, `EXA_API_KEY` (auto-update web search — faster/cheaper than LLM search), `GITHUB_TOKEN` (required for `crux issues` commands and the `/internal/github-issues` dashboard).

### Improving an existing page
```bash
pnpm crux content improve <page-id> --tier=polish --apply
```
Tiers: `polish` (~$2-3), `standard` (default, ~$5-8), `deep` (~$10-15)
Use `--directions "specific instructions"` for targeted improvements.
Use `--apply` to write changes directly (otherwise outputs to temp file for review).
Use `--grade` with `--apply` to auto-grade after improvement.

### After any page edit (manual or pipeline)
```bash
pnpm crux fix escaping              # Auto-fix dollar signs, comparisons, tildes
pnpm crux fix markdown              # Auto-fix list formatting, bold labels
pnpm crux validate unified --rules=comparison-operators,dollar-signs --errors-only  # MUST pass (blocking in CI)
pnpm crux validate schema           # MUST pass (blocking in CI) — validates YAML entity types, fields
pnpm crux validate unified --rules=frontmatter-schema --errors-only  # MUST pass (blocking in CI) — validates MDX frontmatter
pnpm crux validate                  # Full validation (advisory)
```
**Four checks are blocking CI gates:** `unified --rules=comparison-operators,dollar-signs`, `schema`, `unified --rules=frontmatter-schema`, and `unified --rules=numeric-id-integrity`. All must pass before committing.

### Self-review checklist (before committing any page)

Re-read the full page and verify:

1. **Links resolve**: Every `<EntityLink id="X">` has a matching `- id: X` in `data/entities/*.yaml`
2. **Prose matches data**: Claims in prose agree with numbers in tables/charts on the same page
3. **Units are consistent**: Same unit throughout (don't mix years in overview with months in tables)
4. **Rendering works**: For `\$`, `^`, `{}` or LaTeX-like notation, think through MDX rendering. When in doubt, use plain text.

For model/analysis pages, also run the full review checklist in `content/docs/internal/models.mdx` (Part 7).

### CRITICAL: If the Crux pipeline fails, FIX THE PIPELINE — do NOT bypass it

**NEVER write a wiki page manually as a workaround when `pnpm crux content create` or `pnpm crux content improve` fails.** This is the single most important rule for page authoring.

When the crux library fails:
1. **Read the error output carefully.** Identify the root cause (missing data, bad import, schema issue, API error, etc.)
2. **Investigate the relevant crux source code** in `crux/` — the commands, authoring scripts, lib utilities, and validation code are all in this repo and are all fixable.
3. **Fix the bug in the crux library itself**, then re-run the pipeline command.
4. If the fix is non-trivial, ask the user for guidance — but still do not fall back to manual page writing.

Manually written pages are missing: proper citations, EntityLink validation, frontmatter metric syncing, template structure, research integration, and quality grading. They create technical debt that is harder to fix later than fixing the pipeline now.

### If you must create a page manually (last resort, only with explicit user approval)
Write the initial draft, then immediately run the improve pipeline on it:
```bash
pnpm crux content improve <page-id> --tier=polish --apply
```
This adds proper citations, fixes escaping, validates EntityLinks, and syncs frontmatter metrics.

## Agent Session Workflow — MANDATORY

Run `/agent-session-start` **before taking any action** — before reading files, running commands, or writing code. See `## MANDATORY FIRST ACTION` at the top of this file and `.claude/rules/agent-session-workflow.md` for full instructions.

At session end, run `/agent-session-ready-PR` to verify the checklist, polish the PR, and ship.

## GitHub Issue Tracking — MANDATORY

When a session works on a GitHub issue, signal activity on that issue. See `.claude/rules/github-issue-tracking.md` for full instructions. Summary:

1. **At session start**: `pnpm crux issues start <N>` — posts a comment + adds `claude-working` label
2. **At session end**: `pnpm crux issues done <N> --pr=<URL>` — posts completion comment + removes label
3. **To pick the next issue**: `/next-issue` — fetches and ranks open issues, starts work on the top one

## PR Review & Ship Workflow — MANDATORY

Before finishing any session, run the full review-and-ship workflow defined in `.claude/rules/pr-review-guidelines.md`. Run `/agent-session-ready-PR` to verify the checklist, polish the PR, and ship. At bare minimum, always run `/push-and-ensure-green`.

## CI Verification — MANDATORY

**Never assume CI will pass. Always verify.**

### Before pushing: run the gate check
```bash
pnpm crux validate gate          # Runs: build-data, tests, validations, typecheck
pnpm crux validate gate --fix    # Auto-fix escaping + markdown before validating
pnpm crux validate gate --full   # Also runs full Next.js build
```
The gate check bundles all CI-blocking checks into one command. It fails fast — if any step fails, it stops and reports. The `.githooks/pre-push` hook runs this automatically on every `git push`.

**Setup (one-time):** `git config core.hooksPath .githooks`

The gate runs these steps sequentially:
1. Build data layer (`app/scripts/build-data.mjs`) — includes **ID stability check** (see below)
2. Run vitest tests
3. *(with `--fix` only)* Auto-fix escaping and markdown formatting
4. MDX syntax check (comparison-operators, dollar-signs)
5. YAML schema validation
6. Frontmatter schema validation
7. Numeric ID integrity (cross-entity/page duplicate detection)
8. TypeScript type check (`tsc --noEmit`)
9. *(with `--full` only)* Full Next.js production build

**ID stability check (issue #148):** The build-data step verifies that no entity or page numeric IDs (`numericId: E123`) were silently reassigned between builds. If a `numericId` was removed from a source file and the build would assign a different one, the build fails with a list of affected `<EntityLink>` references. To fix: restore the original `numericId` in the source file. To intentionally reassign IDs (rare): `node app/scripts/build-data.mjs --allow-id-reassignment`.

### After pushing: confirm CI is green
```bash
pnpm crux ci status              # Check current CI status
pnpm crux ci status --wait       # Poll every 30s until all checks complete
```
1. **Do not say "CI should pass" — wait for actual confirmation**
2. If checks show `queued` or `in_progress`, use `--wait` to poll automatically
3. If checks fail, investigate the failure, fix locally, and push again
4. Do not consider work complete until CI is green

### CI jobs
- **build-and-test**: Builds the app and runs vitest (blocking)
- **validate**: Runs four blocking checks (MDX syntax, YAML schema, frontmatter schema, numeric ID integrity), then the full validation suite (advisory/non-blocking)

## Auto-Update System

News-driven automatic wiki updates. Fetches from RSS feeds and web searches, routes relevant news to wiki pages, and runs improvements. See `crux/auto-update/` for implementation and `data/auto-update/sources.yaml` for source configuration.

```bash
pnpm crux auto-update plan                    # Preview what would be updated
pnpm crux auto-update run --budget=30         # Run with $30 budget cap
pnpm crux auto-update digest                  # Just fetch and show news digest
pnpm crux auto-update sources                 # List configured sources
pnpm crux auto-update history                 # Show past runs
```

GitHub Actions workflow (`.github/workflows/auto-update.yml`) runs daily at 06:00 UTC. Configurable via `workflow_dispatch` with budget, page count, and source filters.

## Key Conventions

- **Path aliases**: Use `@/`, `@components/`, `@data/`, `@lib/` in app code
- **Entity types**: Canonical list in `app/src/data/entity-type-names.ts`. Category-mapped types (used by page creator): person, organization, risk, approach, model, concept, intelligence-paradigm, capability, crux, debate, event, metric, project. Additional types include: risk-factor, safety-agenda, policy, case-study, scenario, resource, funder, historical, analysis, parameter, argument, table, diagram, insight
- **MDX escaping**: `\$100` not `$100`, `\<100ms` not `<100ms`
- **Tailwind CSS v4** with shadcn/ui components
- **Squiggle models**: See `app/CLAUDE.md` for SquiggleEstimate style guide
- **Internal sidebar** (`app/src/lib/internal-nav.ts`): When adding internal pages, place them in the correct section. "Research" is for research reports/proposals only. Schema/architecture/technical docs go in "Architecture & Schema". Check existing section semantics before adding.
- **Canonical facts & Calc**: Follow `content/docs/internal/canonical-facts.mdx` style guide — use `<F>` for volatile numbers, `<Calc>` for derived computations, `showDate` for temporal claims. Facts YAML in `data/facts/`.
- **Mermaid diagrams**: Follow `content/docs/internal/mermaid-diagrams.mdx` style guide — prefer `flowchart TD`, max 3-4 parallel nodes, use tables for taxonomies, max 15-20 nodes per diagram.
- **Page templates**: Defined in `crux/lib/page-templates.ts`, style guides in `content/docs/internal/`
- **Edit logs**: Per-page edit history in `data/edit-logs/<page-id>.yaml`, auto-maintained by Crux pipelines. Use `pnpm crux edit-log view <page-id>` to inspect. See `crux/lib/edit-log.ts` for the API.

## Internal Dashboards for New Features

**When building significant new features, always consider creating an internal dashboard page** (`/internal/<feature>`) to visualize the feature's data, status, and history. Dashboards are essential for debugging, monitoring, and iterating on features later.

**When to build a dashboard:** Any feature that produces data over time (run history, discovered items, status tracking, metrics) or that involves a pipeline with multiple stages (where seeing intermediate results aids debugging).

**How to build one:**
1. Create `app/src/app/internal/<name>/page.tsx` (server component — loads data)
2. Create `app/src/app/internal/<name>/<name>-table.tsx` (client component — `"use client"` with `DataTable` from `@/components/ui/data-table.tsx`)
3. Add navigation entry in `app/src/lib/wiki-nav.ts` under "Dashboards & Tools"
4. Server components can read YAML/JSON files directly via `fs` for operational data
5. Follow existing patterns in `app/src/app/internal/updates/` or `auto-update-runs/`

**Examples:** Update Schedule, Page Changes, Fact Dashboard, Auto-Update Runs, Auto-Update News, Importance Rankings, Page Similarity, Interventions, Proposals.
