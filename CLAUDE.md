# Longterm Wiki - Claude Code Config

AI safety wiki with ~700 MDX pages, Next.js frontend, YAML data layer, and CLI tooling.

**This is a routing document.** Detailed guides live in `content/docs/internal/` and `.claude/rules/`. Use `pnpm crux <domain> --help` for full CLI reference.

## MANDATORY FIRST ACTION — Do this before anything else

Before reading files, running commands, or writing any code, run:

```bash
pnpm crux agent-checklist init --issue=N   # if working on a GitHub issue
# or
pnpm crux agent-checklist init "Task description" --type=X   # if not on an issue
```

**"Before writing code" is not good enough** — quick fixes, research, and file reads all count. Run it first, then proceed. See `.claude/rules/agent-session-workflow.md` for full workflow.

### Worktree setup (one-time per worktree)

If running in a git worktree (check: `git worktree list`), symlink the env file and node_modules to avoid missing credentials and missing packages:

```bash
# From the worktree root:
ln -sf ../../../.env .env                                                 # env vars (GITHUB_TOKEN etc.)
ln -sf /Users/ozziegooen/Documents/GitHub.nosync/longterm-wiki/apps/web/node_modules apps/web/node_modules  # app packages
```

Without these, `crux` won't have `GITHUB_TOKEN` and the gate check will fail with missing package errors.

See `## Agent Session Workflow — MANDATORY` below and `.claude/rules/agent-session-workflow.md` for full details.

At session end, run `/agent-session-ready-PR`. Always open a PR — never push directly to `main`.

## Quick Reference

```bash
# Setup
pnpm setup:quick                 # Install + build data (first-time)

# Development
pnpm dev                         # Dev server on port 3001
pnpm build                      # Production build
pnpm test                        # Run vitest tests

# Pre-push gate (CI-blocking checks)
pnpm crux validate gate --fix    # Build data + tests + validations + auto-fix

# After any page edit
pnpm crux fix escaping           # Auto-fix dollar signs, comparisons, tildes
pnpm crux fix markdown           # Auto-fix list formatting, bold labels

# Page authoring
pnpm crux content create "Title" --tier=standard
pnpm crux content improve <id> --tier=standard --apply

# Querying (use instead of grepping YAML files)
pnpm crux query search "topic"   # Full-text search
pnpm crux query entity <id>      # Entity data
pnpm crux query related <id>     # Related pages

# Entity ID allocation (never invent IDs manually)
pnpm crux ids allocate <slug>    # Allocate or retrieve numeric ID from server
pnpm crux ids check <slug>       # Look up existing ID for a slug

# Research context (saves many tool calls)
pnpm crux context for-page <id>  # Full context for a page
pnpm crux context for-issue <N>  # Context for a GitHub issue

# Full CLI reference
pnpm crux --help                 # All domains
pnpm crux <domain> --help        # Domain-specific help
```

## Repository Structure

```
longterm-wiki/
├── content/docs/               # ~700 MDX wiki pages
├── data/                       # YAML source data (entities, facts, resources, etc.)
│   ├── entities/               # Entity YAML definitions
│   ├── facts/                  # Canonical facts
│   ├── resources/              # External resource links
│   ├── graphs/                 # Cause-effect graph data
│   └── auto-update/            # Auto-update system state, sources, runs
├── apps/web/                    # Next.js 15 frontend (see apps/web/CLAUDE.md)
├── crux/                       # Crux CLI + validation (see crux/README.md)
└── package.json                # Workspace root
```

## Data Flow

1. YAML files in `data/` define entities, facts, resources
2. `apps/web/scripts/build-data.mjs` transforms YAML + MDX frontmatter → `database.json`
3. Next.js app reads `database.json` at build time
4. MDX pages in `content/docs/` are compiled via next-mdx-remote

## Page Authoring

**Always use the Crux content pipeline.** Do not manually write wiki pages from scratch.

```bash
pnpm crux content create "Page Title" --tier=standard    # budget | standard | premium
pnpm crux content improve <page-id> --tier=standard --apply  # polish | standard | deep
```

**If the pipeline fails, fix the pipeline** — do not bypass it. See the crux source code in `crux/` to diagnose and fix issues. Manually written pages are missing citations, EntityLink validation, frontmatter syncing, and quality grading.

Session logs are written automatically after `--apply` runs. Do not also run `/agent-session-ready-PR` for improve-only sessions.

### After any page edit

Run `pnpm crux fix escaping` and `pnpm crux fix markdown`, then verify with `pnpm crux validate gate --fix`.

**Six checks are CI-blocking:** comparison-operators, dollar-signs, schema, frontmatter-schema, numeric-id-integrity, prefer-entitylink. All are included in the gate.

### Self-review checklist (before committing any page)

1. **Links resolve**: Every `<EntityLink id="X">` has a matching entity in `data/entities/*.yaml`
2. **Prose matches data**: Claims agree with numbers in tables/charts on the same page
3. **No `{/* NEEDS CITATION */}` markers**: Search before committing
4. **Cross-page consistency**: If you edited a person page, check the linked org page for conflicts
5. **MDX rendering**: For `\$`, `^`, `{}` — think through rendering. When in doubt, use plain text

## CI Verification

**Never assume CI will pass. Always verify.**

```bash
pnpm crux validate gate --fix    # Before pushing (also runs as pre-push hook)
pnpm crux ci status --wait       # After pushing — poll until green
```

Do not consider work complete until CI is green.

## Key Conventions

- **Path aliases**: `@/`, `@components/`, `@data/`, `@lib/` in app code
- **Entity types**: Canonical list in `apps/web/src/data/entity-type-names.ts`
- **MDX escaping**: `\$100` not `$100`, `\<100ms` not `<100ms`
- **Tailwind CSS v4** with shadcn/ui components
- **Squiggle models**: See `apps/web/CLAUDE.md` for SquiggleEstimate style guide
- **Page templates**: `crux/lib/page-templates.ts`, style guides in `content/docs/internal/`
- **Canonical facts & Calc**: Follow `content/docs/internal/canonical-facts.mdx` — `<F>` for volatile numbers, `<Calc>` for derived computations
- **Internal sidebar**: `apps/web/src/lib/internal-nav.ts` — check existing section semantics before adding pages
- **Internal dashboards**: For features with data/status over time, create `/internal/<name>` pages following patterns in `apps/web/src/app/internal/`
- **GitHub API**: Use `crux issues/pr/ci` commands for writes. Use MCP GitHub tools for ad-hoc reads. Never raw `curl`.
- **API keys**: In environment variables, NOT `.env` files. Required: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`
- **Entity IDs**: **Never manually invent numericIds** (E42, E886, etc.). Always allocate from the wiki-server: `pnpm crux ids allocate <slug>`. The gate runs `assign-ids.mjs` automatically as a safety net, but allocating early prevents conflicts between concurrent agents. Use `pnpm crux ids check <slug>` to look up existing IDs.

## Detailed Guides (loaded automatically by Claude Code)

- `.claude/rules/agent-session-workflow.md` — Session start/end workflow
- `.claude/rules/github-issue-tracking.md` — Issue tracking with `crux issues`
- `.claude/rules/pr-review-guidelines.md` — PR review and ship process
- `.claude/rules/session-logging.md` — Session log format and storage