# Longterm Wiki

AI safety knowledge base — a wiki covering AI risk models, key organizations, researchers, policy approaches, and the AI Transition Model.

Built with Next.js 15 (App Router), MDX content, and YAML-driven data.

## Getting Started

```bash
pnpm install
cd app && node scripts/build-data.mjs   # Generate database.json from YAML/MDX
pnpm dev                                 # Dev server on port 3001
```

## Repository Structure

```
longterm-wiki/
├── content/docs/          # ~625 MDX wiki pages
├── data/                  # YAML data (entities, facts, resources, insights, graphs)
├── app/                   # Next.js 15 frontend
│   ├── src/               # React components, data layer, pages
│   ├── scripts/           # Build scripts (build-data.mjs)
│   └── public/            # Static assets + LLM files
└── tooling/               # Crux CLI — validation, analysis, content tools
    ├── crux.mjs           # CLI entry point
    ├── commands/          # 8 command domains
    ├── lib/               # Shared utilities + 34 validation rules
    └── validate/          # 23 validation scripts
```

## Commands

All commands run from the repo root unless noted.

### Build & Dev

```bash
pnpm dev                              # Start dev server (port 3001)
pnpm build                            # Production build (auto-runs build-data.mjs)
pnpm test                             # Run vitest tests
```

### Crux CLI

The `crux` CLI provides validation, analysis, content management, and more.

```bash
# Validation
node tooling/crux.mjs validate                  # Run all 28 validators
node tooling/crux.mjs validate unified --fix    # Auto-fix with 34 rule engine

# Content
node tooling/crux.mjs content create "topic"    # Create a new wiki page
node tooling/crux.mjs content improve <page>    # AI-assisted page improvement
node tooling/crux.mjs content regrade           # Re-grade quality ratings

# Analysis
node tooling/crux.mjs analyze                   # Full health report
node tooling/crux.mjs gaps list                 # Find pages needing more content
node tooling/crux.mjs insights check            # Insight quality checks

# Auto-fixes
node tooling/crux.mjs fix entity-links          # Convert markdown links to EntityLink
node tooling/crux.mjs fix markdown              # Fix markdown formatting
node tooling/crux.mjs fix escaping              # Fix LaTeX/JSX escaping issues

# Resources
node tooling/crux.mjs resources list            # Pages with unconverted links
node tooling/crux.mjs resources process <file>  # Convert links to <R> components
```

Run `node tooling/crux.mjs --help` for the full command list.

## Data Flow

```
data/*.yaml + content/docs/*.mdx
        ↓
  app/scripts/build-data.mjs       (build time)
        ↓
  app/src/data/database.json       (631 entities, 587 pages)
        ↓
  app/src/data/index.ts            (runtime data access)
        ↓
  Next.js static generation        (1300+ pre-rendered pages)
```

Entities come from two sources, merged at build time (YAML takes precedence):
1. **YAML files** in `data/entities/` — rich entities with metadata, sources, related entries
2. **MDX frontmatter** — auto-creates minimal entities for pages with `entityType` field

## Entity ID System

Entities have both string slugs (`geoffrey-hinton`) and numeric IDs (`E42`). Wiki pages use numeric IDs as canonical URLs. The mapping is stored in `data/id-registry.json`.

## CI

GitHub Actions runs on push to `main` and PRs:
- **build-and-test** — builds data, runs 53 tests, builds Next.js (blocking)
- **validate** — runs the full validation suite (non-blocking, pre-existing content issues)
