# Longterm Wiki - Claude Code Config

AI safety wiki with ~700 MDX pages, Next.js frontend, YAML data layer, and CLI tooling.

**Production URL**: `https://www.longtermwiki.com` — do NOT use `longterm.wiki`, `longtermwiki.org`, or any other domain.

**This is a routing document.** Detailed guides live in `content/docs/internal/` and `.claude/rules/`. Use `pnpm crux --help` for full CLI reference.

**Agent memory**: Read `.claude/memory/MEMORY.md` at session start for cross-session facts and corrections. Update it when you learn stable new facts.

## MANDATORY FIRST ACTION — Do this before anything else

Before reading files, running commands, or writing any code, run:

```bash
pnpm crux sys agent-checklist init --issue=N   # if working on a GitHub issue
# or
pnpm crux sys agent-checklist init "Task description" --type=X   # if not on an issue
```

**"Before writing code" is not good enough** — quick fixes, research, and file reads all count. Run it first, then proceed. See `.claude/rules/agent-session-workflow.md` for full workflow.

At session end, run `/agent-ship`. Always open a PR — never push directly to `main`.

## Quick Reference

Commands are organized into groups by data layer. Use short prefixes for convenience:

```bash
pnpm setup:quick                 # Install + build data (first-time)
pnpm dev                         # Dev server on port 3001
pnpm build                      # Production build
pnpm test                        # Run vitest tests

# Wiki content (w = wiki)
pnpm crux w validate gate --fix              # Pre-push gate (CI-blocking checks)
pnpm crux w validate gate --scope=content --fix  # Fast content-only (~15s)
pnpm crux w create "Title" --tier=standard   # Create a new page
pnpm crux w improve <id> --tier=standard --apply  # Improve a page
pnpm crux w fix escaping                     # After any page edit
pnpm crux w fix markdown                     # After any page edit

# FactBase (fb = factbase)
pnpm crux fb show <entity>                   # Show FactBase entity
pnpm crux fb source-check                    # Source-check FactBase facts against URLs

# TableBase (tb = tablebase)
pnpm crux tb ids allocate <slug>             # Wiki entity: allocate numericId + stableId
pnpm crux tb ensure-entities --type=person   # Lightweight: stableId only (no wiki page)
pnpm crux tb people discover                 # Discover people entities

# GitHub (gh)
pnpm crux gh issues start <N>               # Signal work start on issue
pnpm crux gh issues done <N> --pr=URL       # Signal completion
pnpm crux gh ci status --wait               # Poll CI until green
pnpm crux gh deploy-tasks detect             # Auto-detect deploy tasks from diff
pnpm crux gh deploy-tasks pending            # Find unchecked tasks from merged PRs
pnpm crux gh deploy-tasks inject --pr=N      # Inject deploy checklist into PR

# System (sys = system)
pnpm crux sys audits list                    # Show audit items, highlight overdue
pnpm crux sys audits check <id> --pass       # Record a check result
pnpm crux sys agent-checklist init --issue=N # Init session checklist

# Cross-cutting (top-level)
pnpm crux query search "topic"               # Full-text search
pnpm crux context for-page <id>              # Full context for a page
pnpm crux context for-issue <N>              # Context for a GitHub issue

pnpm crux --help                             # Full CLI reference
pnpm crux w --help                           # Wiki group help
```

> **Legacy flat syntax still works**: `pnpm crux validate gate --fix` = `pnpm crux w validate gate --fix`

## Repository Structure

```
longterm-wiki/
├── content/docs/               # ~700 MDX wiki pages
├── data/                       # YAML source data (entities, resources, etc.)
├── apps/web/                    # Next.js 15 frontend (see apps/web/CLAUDE.md)
├── crux/                       # Crux CLI + validation (see crux/README.md)
└── package.json                # Workspace root
```

## Entity Directory Pages

The site has structured directory pages for browsing entities by type. Before creating a new directory, check if one already exists:

| Directory | Entity Type | Route | Description |
|-----------|------------|-------|-------------|
| Organizations | `organization` | `/organizations` | Companies, labs, nonprofits with FactBase facts, funding, people |
| People | `person` | `/people` | Researchers, executives with roles, affiliations, publications |
| AI Models | `ai-model` | `/ai-models` | Models with benchmarks, pricing, safety levels |
| Benchmarks | `benchmark` | `/benchmarks` | Evaluation benchmarks with scores across models |
| Legislation | `policy` | `/legislation` | Laws, regulations, executive orders with provisions, stakeholders, votes |
| Projects | `project` | `/projects` | Tools, platforms, research projects |
| Grants | — | `/grants` | Grant records from funding sources |
| Funding Programs | — | `/funding-programs` | Open funding opportunities |
| Divisions | — | `/divisions` | Organizational sub-units |
| Publications | — | `/publications` | Research papers and publications |
| Investments | — | `/investments` | Investment records |
| Funding Rounds | — | `/funding-rounds` | Company funding rounds |
| Approaches | `approach` | `/approaches` | Safety approaches, techniques, and strategies |
| Events | `event` | `/events` | Notable AI safety events |

Entity types without directories (too abstract or sparse for tables): `risk`, `concept` (34), `capability` (25), `analysis` (108), `crux` (18), `safety-agenda` (8), `historical` (5).

Adding a new directory requires: schema in `entity-schemas.ts`, transform in `entity-transform.mjs`, route in `entity-nav.ts`, and App Router pages.

**YAML entities vs PG-primary tables**: Strongly prefer PG-primary tables for new features with dedicated UI/directory pages and structured relational data (the grants, investments, funding-rounds, benchmarks, divisions pattern). YAML entities (`data/entities/`) are for lightweight catalog entries that mainly serve as link targets or wiki page metadata. If the data has numeric fields to aggregate, many-to-many relationships, or its own directory page — use PG.

## Data Layer Terminology — Three Bases

| Name | What it is | Key files |
|------|-----------|-----------|
| **TableBase** | Typed relational records (Postgres/YAML entities) | `apps/web/src/data/tablebase.ts`, `data/entities/` |
| **FactBase** | Structured triples with temporal data, provenance | `packages/factbase/`, `apps/web/src/data/factbase.ts` |
| **WikiBase** | Long-form prose MDX articles | `content/docs/`, `Page` interface in `tablebase.ts` |

**Naming clarifications** (common confusions):
- The PG `entities` table = **TableBase** (a read mirror of `data/entities/*.yaml`). FactBase also has "entities" with separate 10-char IDs — these are different.
- The PG `facts` table = **FactBase mirror** (a read mirror of `packages/factbase/data/things/` YAML). Not the same as the legacy `data/facts/*.yaml`.
- The PG `things` table = **cross-base universal index** (NOT a FactBase concept). It indexes items from ALL domains (entities, facts, grants, resources, etc.).
- `packages/factbase/data/things/` = FactBase entity YAML files. NOT related to the PG `things` table despite the shared name.
- Full naming guide: `content/docs/internal/data-architecture.mdx`

## Data Flow

1. YAML files in `data/` define entities and resources; FactBase data in `packages/factbase/data/things/`
2. `apps/web/scripts/build-data.mjs` transforms YAML + MDX frontmatter → `database.json` + `factbase-data.json`
3. Next.js app reads `database.json` and `factbase-data.json` at build time
4. MDX pages in `content/docs/` are compiled via next-mdx-remote

## Implementation Quality

- **Thorough over fast.** Robust implementations that handle edge cases beat quick ones that only cover the happy path. See `.claude/rules/implementation-quality.md`.

## Key Conventions

- **Branch discipline**: After any `git checkout`, verify the branch with `git branch --show-current` before continuing work. Never edit files on `main` — a PreToolUse hook blocks Edit/Write on main. If a dev server was running, restart it after switching branches (Next.js serves from the current working directory, not the branch the server was started from).
- **Path aliases**: `@/`, `@components/`, `@data/`, `@lib/` in app code
- **Entity types**: Canonical list in `apps/web/src/data/entity-type-names.ts`
- **MDX escaping**: `\$100` not `$100`, `\<100ms` not `<100ms`
- **Tailwind CSS v4** with shadcn/ui components
- **Page templates**: `crux/lib/page-templates.ts`, style guides in `content/docs/internal/`
- **FactBase facts & Calc**: FactBase YAML (`packages/factbase/data/things/`) is the sole authoritative source for structured facts. Use `<FBF>` / `<FBFactValue>` in MDX, `<Calc>` for computed values. See `content/docs/internal/canonical-facts.mdx`.
- **Internal sidebar**: `apps/web/src/lib/wiki-nav.ts`
- **GitHub API**: Use `crux gh issues/pr/ci/epic` commands — never raw `curl`
- **Entity IDs — two tiers**:
  - **Wiki entities** (orgs, concepts, important people with their own pages): Use `pnpm crux tb ids allocate <slug>` to get a `numericId` (E-number) + `stableId`. These get wiki pages at `/wiki/E<N>`. Only ~200-300 entities should have these.
  - **TableBase reference records** (paper authors, personnel, minor people): Use `generateId("person:<slug>")` for a `stableId` only. NO `numericId`, no wiki page. Stored in the entities table for directory/personnel use but are lightweight. Use `crux tb ensure-entities` or `crux tb create-entity` for these.
  - **Never manually invent IDs** — use the functions above.
- **Hono RPC**: Mandatory for new wiki-server routes. See `.claude/rules/wiki-server-rpc-migration.md`
- **Content pages use local data**: Wiki pages read `database.json` — zero runtime API calls. Only internal dashboards make live wiki-server requests.
- **API keys**: In environment variables, NOT `.env` files. Required: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`
- **Wiki-server env switching**: Set `WIKI_SERVER_ENV=prod` to target the production wiki-server instead of localhost. This makes all `LONGTERMWIKI_*` env var lookups use the `PROD_` prefix (e.g., `PROD_LONGTERMWIKI_SERVER_URL`). Usage: `WIKI_SERVER_ENV=prod pnpm crux query search "anthropic"`
- **No new bash scripts**: Write new scripts/tools as TypeScript in `crux/`. Bash is only acceptable for git hooks (`.githooks/`), Claude Code hooks (`.claude/hooks/`), and CI glue where Node.js isn't available.

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
- `.claude/rules/implementation-quality.md` — Thoroughness, testing depth, self-review
- `.claude/rules/auto-update-system.md` — Auto-update system
