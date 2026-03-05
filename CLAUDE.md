# Longterm Wiki - Claude Code Config

AI safety wiki with ~700 MDX pages, Next.js frontend, YAML data layer, and CLI tooling.

**Production URL**: `https://www.longtermwiki.com` — do NOT use `longterm.wiki`, `longtermwiki.org`, or any other domain.

**This is a routing document.** Detailed guides live in `content/docs/internal/` and `.claude/rules/`. Use `pnpm crux <domain> --help` for full CLI reference.

**Agent memory**: Read `.claude/memory/MEMORY.md` at session start for cross-session facts and corrections. Update it when you learn stable new facts.

## MANDATORY FIRST ACTION — Do this before anything else

Before reading files, running commands, or writing any code, run:

```bash
pnpm crux agent-checklist init --issue=N   # if working on a GitHub issue
# or
pnpm crux agent-checklist init "Task description" --type=X   # if not on an issue
```

**"Before writing code" is not good enough** — quick fixes, research, and file reads all count. Run it first, then proceed. See `.claude/rules/agent-session-workflow.md` for full workflow.

At session end, run `/agent-session-ready-PR`. Always open a PR — never push directly to `main`.

## Quick Reference

```bash
pnpm setup:quick                 # Install + build data (first-time)
pnpm dev                         # Dev server on port 3001
pnpm build                      # Production build
pnpm test                        # Run vitest tests

pnpm crux validate gate --fix    # Pre-push gate (CI-blocking checks)
pnpm crux validate gate --scope=content --fix   # Fast content-only (~15s)

pnpm crux content create "Title" --tier=standard
pnpm crux content improve <id> --tier=standard --apply
pnpm crux fix escaping           # After any page edit
pnpm crux fix markdown           # After any page edit

pnpm crux query search "topic"   # Full-text search
pnpm crux ids allocate <slug>    # Allocate entity ID (never invent manually)
pnpm crux context for-page <id>  # Full context for a page
pnpm crux context for-issue <N>  # Context for a GitHub issue

pnpm crux issues start <N>      # Signal work start on issue
pnpm crux issues done <N> --pr=URL  # Signal completion
pnpm crux ci status --wait       # Poll CI until green

pnpm crux audits list            # Show audit items, highlight overdue
pnpm crux audits check <id> --pass  # Record a check result
pnpm crux audits run-auto        # Run automated checks

pnpm crux --help                 # Full CLI reference
```

## Repository Structure

```
longterm-wiki/
├── content/docs/               # ~700 MDX wiki pages
├── data/                       # YAML source data (entities, facts, resources, etc.)
├── apps/web/                    # Next.js 15 frontend (see apps/web/CLAUDE.md)
├── crux/                       # Crux CLI + validation (see crux/README.md)
└── package.json                # Workspace root
```

## Data Flow

1. YAML files in `data/` define entities, facts, resources
2. `apps/web/scripts/build-data.mjs` transforms YAML + MDX frontmatter → `database.json`
3. Next.js app reads `database.json` at build time
4. MDX pages in `content/docs/` are compiled via next-mdx-remote

## Key Conventions

- **Path aliases**: `@/`, `@components/`, `@data/`, `@lib/` in app code
- **Entity types**: Canonical list in `apps/web/src/data/entity-type-names.ts`
- **MDX escaping**: `\$100` not `$100`, `\<100ms` not `<100ms`
- **Tailwind CSS v4** with shadcn/ui components
- **Page templates**: `crux/lib/page-templates.ts`, style guides in `content/docs/internal/`
- **Canonical facts & Calc**: Follow `content/docs/internal/canonical-facts.mdx`
- **Internal sidebar**: `apps/web/src/lib/wiki-nav.ts`
- **GitHub API**: Use `crux issues/pr/ci/epic` commands — never raw `curl`
- **Entity IDs**: Never manually invent — always `pnpm crux ids allocate <slug>`
- **Hono RPC**: Mandatory for new wiki-server routes. See `.claude/rules/wiki-server-rpc-migration.md`
- **Content pages use local data**: Wiki pages read `database.json` — zero runtime API calls. Only internal dashboards make live wiki-server requests.
- **API keys**: In environment variables, NOT `.env` files. Required: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`
- **Wiki-server env switching**: Set `WIKI_SERVER_ENV=prod` to target the production wiki-server instead of localhost. This makes all `LONGTERMWIKI_*` env var lookups use the `PROD_` prefix (e.g., `PROD_LONGTERMWIKI_SERVER_URL`). Usage: `WIKI_SERVER_ENV=prod pnpm crux statements improve anthropic --dry-run`

## Detailed Guides (loaded automatically by Claude Code)

- `.claude/rules/agent-session-workflow.md` — Session start/end workflow
- `.claude/rules/environment-setup.md` — Worktree + LSP setup
- `.claude/rules/page-authoring.md` — Content pipeline, self-review checklist
- `.claude/rules/code-review-guidelines.md` — Code review rules
- `.claude/rules/github-issue-tracking.md` — Issue tracking with `crux issues`
- `.claude/rules/proactive-github-filing.md` — When/how to file issues
- `.claude/rules/pr-review-guidelines.md` — PR review and ship process
- `.claude/rules/pre-pr-verification.md` — Build/test/gate checks before PRs
- `.claude/rules/session-logging.md` — Session log format and storage
- `.claude/rules/error-handling.md` — Error handling strategy and `.catch()` patterns
- `.claude/rules/database-migrations.md` — Migration patterns and deploy flow
- `.claude/rules/wiki-server-rpc-migration.md` — Hono RPC migration guide
- `.claude/rules/internal-dashboards.md` — Dashboard creation pattern
- `.claude/rules/auto-update-system.md` — Auto-update system
