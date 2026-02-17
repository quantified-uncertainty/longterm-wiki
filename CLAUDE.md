# Longterm Wiki - Claude Code Config

AI safety wiki with ~625 MDX pages, Next.js frontend, YAML data layer, and CLI tooling.

**Keep CLAUDE.md as a routing document** — brief instructions and pointers to detailed guides. Detailed style guidance, checklists, and templates live in `content/docs/internal/` (see Page templates below). Do not expand CLAUDE.md with long explanations; instead add detail to the appropriate internal style guide and reference it from here.

## Quick Reference

```bash
# Development
pnpm dev                         # Start dev server on port 3001
pnpm build                      # Production build (runs build-data automatically)

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

**API keys are in environment variables** (`process.env`), NOT in `.env` files. Check `env | grep -i API` to verify available keys before assuming they're missing. Required keys: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`. Optional: `FIRECRAWL_KEY`, `SCRY_API_KEY`.

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
**Three checks are blocking CI gates:** `unified --rules=comparison-operators,dollar-signs`, `schema`, and `unified --rules=frontmatter-schema`. All must pass before committing.

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

## PR Review & Ship Workflow — MANDATORY

Before finishing any session, run the full review-and-ship workflow defined in `.claude/rules/pr-review-guidelines.md`. The sequence is: `/review` (fix all issues) → `/push-safe` (push + CI green) → conflict check. This is enforced automatically via the rules file.

## CI Verification — MANDATORY

**Never assume CI will pass. Always verify.**

### Before pushing: run the gate check
```bash
pnpm crux validate gate          # Runs: build-data, tests, 3 blocking validations
pnpm crux validate gate --full   # Also runs full Next.js build
```
The gate check bundles all CI-blocking checks into one command. It fails fast — if any step fails, it stops and reports. The `.githooks/pre-push` hook runs this automatically on every `git push`.

**Setup (one-time):** `git config core.hooksPath .githooks`

The gate runs these steps sequentially:
1. Build data layer (`app/scripts/build-data.mjs`)
2. Run vitest tests
3. MDX syntax check (comparison-operators, dollar-signs)
4. YAML schema validation
5. Frontmatter schema validation
6. *(with `--full` only)* Full Next.js production build

### After pushing: confirm CI is green
1. Check CI status using the GitHub API (`gh` is not installed; use `curl` instead):
```bash
# Get the HEAD sha
SHA=$(git rev-parse HEAD)
# Query check runs (requires GITHUB_TOKEN in env)
curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/commits/$SHA/check-runs" \
  | python3 -c "
import sys, json; data = json.load(sys.stdin)
for r in data.get('check_runs', []):
    print(f\"  {r['name']:40s} {r['status']:12s} {r.get('conclusion') or '(pending)'}\")
print(f\"Total: {data['total_count']} checks\")
"
```
2. **Do not say "CI should pass" — wait for actual confirmation**
3. If checks show `queued` or `in_progress`, wait 30-60s and poll again
4. If checks fail, investigate the failure, fix locally, and push again
5. Do not consider work complete until CI is green

### CI jobs
- **build-and-test**: Builds the app and runs vitest (blocking)
- **validate**: Runs three blocking checks (MDX syntax, YAML schema, frontmatter schema), then the full validation suite (advisory/non-blocking)

## Key Conventions

- **Path aliases**: Use `@/`, `@components/`, `@data/`, `@lib/` in app code
- **Entity types**: Canonical list in `app/src/data/entity-type-names.ts`. Category-mapped types (used by page creator): person, organization, risk, approach, model, concept, intelligence-paradigm, capability, crux, debate, event, metric, project. Additional types include: risk-factor, safety-agenda, policy, case-study, scenario, resource, funder, historical, analysis, parameter, argument, table, diagram, insight
- **MDX escaping**: `\$100` not `$100`, `\<100ms` not `<100ms`
- **Tailwind CSS v4** with shadcn/ui components
- **Squiggle models**: See `app/CLAUDE.md` for SquiggleEstimate style guide
- **Internal sidebar** (`app/src/lib/internal-nav.ts`): When adding internal pages, place them in the correct section. "Research" is for research reports/proposals only. Schema/architecture/technical docs go in "Architecture & Schema". Check existing section semantics before adding.
- **Mermaid diagrams**: Follow `content/docs/internal/mermaid-diagrams.mdx` style guide — prefer `flowchart TD`, max 3-4 parallel nodes, use tables for taxonomies, max 15-20 nodes per diagram.
- **Page templates**: Defined in `crux/lib/page-templates.ts`, style guides in `content/docs/internal/`
- **Edit logs**: Per-page edit history in `data/edit-logs/<page-id>.yaml`, auto-maintained by Crux pipelines. Use `pnpm crux edit-log view <page-id>` to inspect. See `crux/lib/edit-log.ts` for the API.
