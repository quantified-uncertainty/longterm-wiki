# Longterm Wiki - Claude Code Config

AI safety wiki with ~625 MDX pages, Next.js frontend, YAML data layer, and CLI tooling.

## Quick Reference

```bash
# Development
pnpm dev                         # Start dev server on port 3001
pnpm build                      # Production build (runs build-data automatically)

# Testing
pnpm test                        # Run vitest tests

# Tooling
node tooling/crux.mjs validate   # Run all validation checks
node tooling/crux.mjs --help     # Show all CLI domains
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
├── tooling/                    # Crux CLI + validation
│   ├── crux.mjs                # CLI entry point
│   ├── commands/               # CLI domain handlers
│   ├── lib/                    # Shared utilities + validation rules
│   └── validate/               # Validation scripts
└── package.json                # Workspace root
```

## Data Flow

1. YAML files in `data/` define entities, facts, resources
2. `app/scripts/build-data.mjs` transforms YAML + MDX frontmatter → `database.json`
3. Next.js app reads `database.json` at build time
4. MDX pages in `content/docs/` are compiled via next-mdx-remote

## Key Conventions

- **Path aliases**: Use `@/`, `@components/`, `@data/`, `@lib/` in app code
- **Entity types**: risk, person, organization, approach, model, concept, etc.
- **MDX escaping**: `\$100` not `$100`, `\<100ms` not `<100ms`
- **Tailwind CSS v4** with shadcn/ui components

## Squiggle Model Style Guide

When creating or editing `<SquiggleEstimate>` models in MDX pages, follow these conventions:

### Distribution Design
- **Never use point values in mixtures.** `mixture(500e9, 350e9, ...)` creates jagged multimodal spikes. Use continuous distributions: `mixture(400e9 to 650e9, 250e9 to 450e9, ...)`.
- **Use `X to Y` (log-normal) syntax** for quantities with natural uncertainty ranges. Reserve `normal()` for symmetric quantities near zero.
- **Prefer broad, overlapping scenario ranges** that reflect genuine uncertainty rather than narrow point estimates. Scenarios should capture the *range* of each case, not a single number.

### Model Structure
- **Keep models 5–30 lines.** Break larger analyses into multiple `<SquiggleEstimate>` blocks with descriptive titles.
- **Comment key assumptions** inline (e.g., `// 80% pledged based on GWWC data`).
- **Name intermediate variables clearly**: `founderEquity`, `pledgedAmount` — not `x`, `temp`.
- **Always title the estimate**: `<SquiggleEstimate title="Descriptive Title" code={...} />`.

### Performance
- The default `sampleCount` is 5000. This is sufficient for most models. For models with many nested operations or very wide distributions, consider whether the output distribution is smooth enough.

### Usage Pattern
```mdx
<SquiggleEstimate title="Expected Revenue (2026)" code={`
// Revenue scenarios with probability weights
high = 8e9 to 15e9
base = 4e9 to 9e9
low = 1e9 to 4e9

revenue = mixture(high, base, low, [0.2, 0.5, 0.3])
revenue
`} />
```
