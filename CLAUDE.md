# Longterm Wiki - Claude Code Config

AI safety wiki with ~625 MDX pages, Next.js frontend, YAML data layer, and CLI tooling.

## Quick Reference

```bash
# Development
pnpm dev                         # Start dev server on port 3001
pnpm build                      # Production build (runs build-data automatically)

# Testing
pnpm test                        # Run vitest tests

# Tooling (Crux CLI)
pnpm crux validate               # Run all validation checks
pnpm crux --help                 # Show all CLI domains
pnpm crux content improve <id>   # Improve a wiki page
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
│   └── id-registry.json        # Persistent numeric ID mapping
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
Tiers: `polish` (quick, ~$2-3), `standard` (with research, ~$5-8), `deep` (full research, ~$10-15)

**API keys are in environment variables** (`process.env`), NOT in `.env` files. Check `env | grep -i API` to verify available keys before assuming they're missing. Required keys: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`. Optional: `FIRECRAWL_KEY`, `SCRY_API_KEY`.

### Improving an existing page
```bash
pnpm crux content improve <page-id> --tier=polish --apply
```
Use `--directions "specific instructions"` for targeted improvements.
Use `--apply` to write changes directly (otherwise outputs to temp file for review).
Use `--grade` with `--apply` to auto-grade after improvement.

### After any page edit (manual or pipeline)
```bash
pnpm crux fix escaping              # Auto-fix dollar signs, comparisons, tildes
pnpm crux fix markdown              # Auto-fix list formatting, bold labels
pnpm crux validate unified --rules=comparison-operators,dollar-signs --errors-only  # MUST pass (blocking in CI)
pnpm crux validate                  # Full validation (advisory)
```
**The `unified --rules=...` check is the blocking CI gate.** Always run it before committing. Use `--fix` to auto-fix issues.

### If you must create a page manually
Write the initial draft, then immediately run the improve pipeline on it:
```bash
pnpm crux content improve <page-id> --tier=polish --apply
```
This adds proper citations, fixes escaping, validates EntityLinks, and syncs frontmatter metrics.

## CI Verification — MANDATORY

**Never assume CI will pass. Always verify.**

### Before pushing: run CI checks locally
```bash
cd app && node scripts/build-data.mjs            # 1. Build data layer
pnpm test                                         # 2. Run all tests (must be 0 failures)
pnpm crux validate unified --rules=comparison-operators,dollar-signs --errors-only  # 3. Blocking validation
pnpm build                                        # 4. Full Next.js build (catches compile errors)
```
All four must succeed before pushing. If any fail, fix the issue first.

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
- **validate**: Runs `pnpm crux validate unified --rules=comparison-operators,dollar-signs --errors-only` (blocking), then the full validation suite (advisory/non-blocking)

## Key Conventions

- **Path aliases**: Use `@/`, `@components/`, `@data/`, `@lib/` in app code
- **Entity types**: risk, person, organization, approach, model, concept, etc.
- **MDX escaping**: `\$100` not `$100`, `\<100ms` not `<100ms`
- **Tailwind CSS v4** with shadcn/ui components
- **Squiggle models**: See `app/CLAUDE.md` for SquiggleEstimate style guide
- **Internal sidebar** (`app/src/lib/internal-nav.ts`): When adding internal pages, place them in the correct section. "Research" is for research reports/proposals only. Schema/architecture/technical docs go in "Architecture & Schema". Check existing section semantics before adding.
- **Mermaid diagrams**: Follow `content/docs/internal/mermaid-diagrams.mdx` style guide — prefer `flowchart TD`, max 3-4 parallel nodes, use tables for taxonomies, max 15-20 nodes per diagram.
- **Page templates**: Defined in `crux/lib/page-templates.ts`, style guides in `content/docs/internal/`
