# Crux — Longterm Wiki CLI Tooling

Crux is the unified CLI for the Longterm Wiki project. It handles validation, content authoring, analysis, code generation, and automated fixes across ~625 MDX wiki pages and their YAML data layer.

## Quick Start

```bash
# Run via pnpm (from project root)
pnpm crux <domain> <command> [options]
pnpm crux --help

# Or invoke directly
node crux/crux.mjs <domain> <command> [options]

# Examples
pnpm crux validate                          # Run all validation checks
pnpm crux content improve far-ai --tier deep
pnpm crux updates list --overdue
```

## Architecture

```
crux.mjs                  CLI entry point — parses args, dispatches to domains
│
├── commands/             Domain handlers (one file per domain)
│   ├── validate.ts       Validation checks (compile, unified rules, quality)
│   ├── analyze.ts        Analysis & reporting
│   ├── fix.ts            Auto-fix operations
│   ├── content.ts        Page authoring (improve, create, grade)
│   ├── generate.ts       Content generation (YAML, summaries, diagrams)
│   ├── resources.ts      External resource management
│   └── updates.ts        Schedule-aware page update system
│
├── authoring/            Page authoring scripts (invoked by content domain)
│   ├── page-creator.ts   Create new pages with research pipeline
│   ├── page-improver.ts  Improve existing pages with AI
│   ├── grade-content.ts  3-step AI grading pipeline
│   ├── grade-by-template.ts   Grade pages against template requirements
│   ├── regrade.ts        Quick re-grade wrapper
│   ├── post-improve.ts   Post-improvement cleanup
│   └── creator/          Sub-modules for page-creator
│
├── lib/                  Shared utilities
│   ├── cli.ts            CLI helpers (buildCommands)
│   ├── content-types.ts  Path constants, type definitions
│   ├── file-utils.ts     File discovery (findMdxFiles)
│   ├── mdx-utils.ts      MDX/frontmatter parsing
│   ├── metrics-extractor.ts   Content metrics (word count, tables, etc.)
│   ├── page-templates.ts      Page template definitions (shared by grading & authoring)
│   ├── validation-engine.ts   Rule-based validation framework
│   ├── rules/            Individual validation rules
│   ├── anthropic.ts      Claude API wrapper
│   ├── output.ts         Logging/formatting
│   └── ...
│
├── validate/             Validation scripts (invoked by validate domain)
├── analyze/              Analysis scripts
├── fix/                  Auto-fix scripts
└── generate/             Generation scripts
```

## What Operates On What

| Domain | Reads | Writes |
|--------|-------|--------|
| **validate** | `content/docs/`, `data/` | stdout (reports) |
| **analyze** | `content/docs/`, `data/`, `app/src/data/` | stdout, `.claude/temp/` |
| **fix** | `content/docs/` | `content/docs/` (in-place fixes) |
| **content** | `content/docs/`, `app/src/data/pages.json` | `content/docs/`, `.claude/temp/` |
| **generate** | `data/`, `content/docs/` | `data/`, `content/docs/` |
| **resources** | `data/resources/` | `data/resources/` |
| **updates** | `content/docs/` frontmatter | invokes `content improve` |

## Domain Reference

- **validate** — MDX compilation checks, unified rule engine (dollar signs, links, frontmatter schema, etc.), quality audits
- **analyze** — Link coverage, entity link analysis, full-wiki reports
- **fix** — Auto-fix cross-links, component imports, and rule violations
- **content** — AI-powered page creation, improvement, and grading pipelines
- **generate** — Generate YAML entities, summaries, diagrams, schema docs
- **resources** — Manage external resource links in `data/resources/`
- **updates** — Schedule-aware update queue using `update_frequency` frontmatter

## How to Add a Validation Rule

1. Create a rule file in `lib/rules/` following the existing pattern
2. Register it in the `ValidationEngine` (see `lib/validation-engine.ts`)
3. The rule will be available via `crux validate unified --rules=<your-rule>`

## How to Add a CLI Command

1. Add a handler function to the appropriate `commands/<domain>.ts`
2. For script-based commands, add an entry to the `SCRIPTS` object with `script:` pointing to the script path (relative to `crux/`)
3. For inline commands, export an async function matching the command name
4. Add to the `commands` export and update `getHelp()`

## Style Guides and Templates

**Style guides** live in `content/docs/internal/` as MDX pages (e.g., `risk-style-guide.mdx`, `response-style-guide.mdx`). These are human-readable reference documents.

**Page templates** are defined in `lib/page-templates.ts`. Each template specifies required frontmatter fields, required sections, and quality criteria. Templates are currently used by `grade-by-template.ts` for scoring pages against their declared template.

Pages declare their template via the `pageTemplate` frontmatter field (e.g., `pageTemplate: knowledge-base-risk`).

**Current integration state**: Templates are used for post-hoc grading only. The authoring tools (page-creator, page-improver) do not yet reference templates or style guides during content generation — this is planned for a future enhancement.
