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
├── tooling/                    # Crux CLI + validation (see tooling/README.md)
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

## Key Conventions

- **Path aliases**: Use `@/`, `@components/`, `@data/`, `@lib/` in app code
- **Entity types**: risk, person, organization, approach, model, concept, etc.
- **MDX escaping**: `\$100` not `$100`, `\<100ms` not `<100ms`
- **Tailwind CSS v4** with shadcn/ui components
- **Squiggle models**: See `app/CLAUDE.md` for SquiggleEstimate style guide
- **Page templates**: Defined in `tooling/lib/page-templates.mjs`, style guides in `content/docs/internal/`
