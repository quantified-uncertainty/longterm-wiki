# Longterm Wiki - Claude Code Config

AI safety wiki with ~700 MDX pages, Next.js frontend, YAML data layer, and CLI tooling.

**Production URL**: `https://www.longtermwiki.com` — do NOT use `longterm.wiki`, `longtermwiki.org`, or any other domain.

**This is a routing document.** Detailed guides live in `content/docs/internal/`, `.claude/rules/` (Tier 1 — auto-loaded session rules), and `docs/agent-rules/` (Tier 2 — subsystem maps, read on-demand). Use `pnpm crux --help` for full CLI reference.

**Agent memory**: Read `.claude/memory/MEMORY.md` at session start for cross-session facts and corrections. Update it when you learn stable new facts.

## MANDATORY FIRST ACTION — Do this before anything else

Before reading files, running commands, or writing any code, run:

```bash
pnpm crux sys agent-checklist init --issue=N   # if working on a GitHub issue
# or
pnpm crux sys agent-checklist init "Task description" --type=X   # if not on an issue
```

**"Before writing code" is not good enough** — quick fixes, research, and file reads all count. Run it first, then proceed. See `.claude/rules/agent-session-workflow.md` for full workflow.

At session end, run `/agent-ship` (if shipping a PR) or `/agent-end` (if not). Never push directly to `main`.

**Track what you discover.** Before ending any session, enumerate every problem you observed and mark each `fixed | filed:QUA-NNN | deferred:<reason>`. Certain red flags (prod incidents, symptom patches, misdiagnoses, premature "Done", N+ repeated symptoms) MUST produce a Linear ticket — "I'll remember" is not a valid disposition. See `.claude/rules/proactive-github-filing.md` § "Mandatory tracking" and `.claude/rules/agent-session-workflow.md` § "Step 2a".

## Quick Reference

Commands are organized into groups by data layer. Use short prefixes for convenience:

```bash
pnpm setup:quick                 # Install + build data (first-time)
pnpm dev                         # Dev server on port 3001
pnpm build                      # Production build
pnpm test                        # Run vitest tests

# Playwright e2e tests (run from apps/web/)
cd apps/web && npx playwright test                    # All e2e tests (local server)
cd apps/web && npx playwright test e2e/render-audit.spec.ts  # Render quality audit
cd apps/web && PLAYWRIGHT_BASE_URL=https://www.longtermwiki.com npx playwright test  # Against prod

# Wiki content (w = wiki)
pnpm crux w validate gate --fix              # Pre-push gate (CI-blocking checks)
pnpm crux w validate gate --scope=content --fix  # Fast content-only (~15s)
pnpm crux w create "Title" --tier=standard   # Create a new page
pnpm crux w improve <id> --tier=standard --apply  # Improve a page
pnpm crux w fix escaping                     # After any page edit
pnpm crux w fix markdown                     # After any page edit

# FactBase (fb = factbase)
pnpm crux fb show <entity>                   # Show FactBase entity
pnpm crux fb sourcing                    # Source-check FactBase facts against URLs

# TableBase (tb = tablebase)
pnpm crux tb ids allocate <slug>             # Wiki entity: allocate numericId + stableId
pnpm crux tb ensure-entities --type=person   # Lightweight: stableId only (no wiki page)
pnpm crux tb people discover                 # Discover people entities

# Linear (primary issue tracker)
pnpm crux linear search "query"              # Search Linear issues
pnpm crux linear create "title" --description="..." --project="..."  # Create a new Linear issue (--project required)
pnpm crux linear start QUA-NNN              # Signal work start on issue
pnpm crux linear done QUA-NNN --pr=URL      # Signal completion
pnpm crux linear view QUA-NNN              # View issue details

# GitHub (gh) — PRs, CI, legacy issues
pnpm crux gh ci status --wait               # Poll CI until green
pnpm crux gh deploy-tasks detect             # Auto-detect deploy tasks from diff
pnpm crux gh deploy-tasks pending            # Find unchecked tasks from merged PRs
pnpm crux gh deploy-tasks inject --pr=N      # Inject deploy checklist into PR
pnpm crux gh issues start <N>               # Signal work start (legacy GitHub issues only)
pnpm crux gh issues done <N> --pr=URL       # Signal completion (legacy GitHub issues only)

# System (sys = system)
pnpm crux sys audits list                    # Show audit items, highlight overdue
pnpm crux sys audits check <id> --pass       # Record a check result
pnpm crux sys agent-checklist init --linear=QUA-NNN  # Init session checklist (Linear)
pnpm crux sys agent-checklist init --issue=N # Init session checklist (legacy GitHub)
pnpm crux sys agent-reset                   # Show stale processes (MCP, dev servers)
pnpm crux sys agent-reset --kill             # Kill stale processes
pnpm crux sys dispatch --linear=QUA-NNN --slot=N  # Open a slot after pre-flight dedup checks

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
- The PG `facts` table = **FactBase mirror** (a read mirror of `packages/factbase/data/fb-entities/` YAML). Not the same as the legacy `data/facts/*.yaml`.
- The PG `things` table = **cross-base universal index** (NOT a FactBase concept). It indexes items from ALL domains (entities, facts, grants, resources, etc.).
- `packages/factbase/data/fb-entities/` = FactBase entity YAML files. Not related to the PG `things` table (the directory was renamed from `things/` in QUA-501 to eliminate the name collision).
- Full naming guide: `content/docs/internal/data-architecture.mdx`

## Data Flow

1. YAML files in `data/` define entities and resources; FactBase data in `packages/factbase/data/fb-entities/`
2. `apps/web/scripts/build-data.mjs` transforms YAML + MDX frontmatter → `database.json` + `factbase-data.json`
3. Next.js app reads `database.json` and `factbase-data.json` at build time
4. MDX pages in `content/docs/` are compiled via next-mdx-remote

## Implementation Quality

- **Thorough over fast.** Robust implementations that handle edge cases beat quick ones that only cover the happy path. See `.claude/rules/implementation-quality.md`.

## Problem-Solving: Fix Systems, Not Instances

When you encounter any problem — a bug, a process failure, a repeated mistake — **do not jump to fixing the specific instance.** First, think one or more levels up:

1. **What class of problem is this?** (e.g., "patrol missed a check" → "check name matching is brittle")
2. **What systemic change prevents the entire class?** (e.g., use substring matching instead of exact strings)
3. **Can you go even more meta?** (e.g., "why do we have hardcoded names at all? Can we derive them from the API?")
4. **Implement the systemic fix** — update code, rules, hooks, docs, or tests
5. **Then** fix the specific instance

This applies to everything: code bugs, process failures, documentation gaps, agent behavior issues. The goal is that each problem you encounter makes the system permanently more robust, not just patches the symptom. Inspired by Toyota's 5 Whys, Google SRE blameless postmortems, and the principle that you can't fix behavior but you can fix systems.

## Key Conventions

- **Slot isolation — CRITICAL**: Each agent slot (`a1`–`a20`) is an independent workspace that may have an active Claude session. **NEVER** interact with slots you don't own: no `cd` into them, no dispatching subagents to them, no killing their tmux windows, no running commands in their directories. If you need branch isolation for PR fixes, use `/tmp/` worktrees from the `main/` clone. If you need to kill a process or tmux window, **ask the user first** — what looks idle from outside may have active work. Violating this rule has caused data loss (destroyed active sessions with in-progress work). See `.claude/rules/slot-isolation.md`.
- **Branch discipline**: Never switch branches mid-session — PreToolUse hooks block `git checkout <branch>`, `git switch`, and `git stash`. **Do NOT use `isolation: "worktree"` in Agent calls** — it has a [confirmed Claude Code bug](https://github.com/anthropics/claude-code/issues/42282) that corrupts the parent session's working directory and bricks the session (reconfirmed 2026-04-16 during QUA-554 scoping — the bug is unpatched). For headless coordinator work use `./ws dispatch <N> "<prompt>"` (QUA-554); for interactive work use `./ws open <N> --claude`. For branch isolation, use agent workspace slots (`lw/a1`–`lw/a15`). See `.claude/rules/worktree-isolation-bug.md`. To create a new branch from the current one, `git checkout -b claude/<description>` is allowed. Never edit files on `main` — a PreToolUse hook blocks Edit/Write on main. If a dev server was running, restart it after switching branches (Next.js serves from the current working directory, not the branch the server was started from).
- **`tmux send-keys` to user-visible panes**: when sending a command into a tmux pane the user is watching (e.g. their right pane), do **not** pipe through `head`, `tail`, or `grep`. Those filters hide live progress (the user sees a frozen prompt until the whole pipeline finishes) and discard the lines they actually want to see. Send the bare command and let the full output stream into the pane.
- **Path aliases**: `@/`, `@components/`, `@data/`, `@lib/` in app code
- **Entity types**: Canonical list in `apps/web/src/data/entity-type-names.ts`
- **MDX escaping**: `\$100` not `$100`, `\<100ms` not `<100ms`
- **Tailwind CSS v4** with shadcn/ui components
- **Page templates**: `crux/lib/page-templates.ts`, style guides in `content/docs/internal/`
- **FactBase facts & Calc**: FactBase YAML (`packages/factbase/data/fb-entities/`) is the sole authoritative source for structured facts. Use `<FBF>` / `<FBFactValue>` in MDX, `<Calc>` for computed values. See `content/docs/internal/canonical-facts.mdx`.
- **Internal sidebar**: `apps/web/src/lib/wiki-nav.ts`
- **Issue tracking**: **Linear is the primary issue tracker** — use `crux linear` commands for issue creation, tracking, and updates. GitHub is used for PRs, CI, and legacy issues only. Use `crux gh pr/ci/epic` commands for GitHub — never raw `curl`
- **Entity IDs — two tiers**:
  - **Wiki entities** (orgs, concepts, important people with their own pages): Use `pnpm crux tb ids allocate <slug>` to get a `numericId` (E-number) + `stableId` (`sid_` prefix, e.g. `sid_1LcLlMGLbw`). These get wiki pages at `/wiki/E<N>`. Only ~200-300 entities should have these.
  - **TableBase reference records** (paper authors, personnel, minor people): Use `generateId("person:<slug>")` for a `stableId` only (`sid_` prefix). NO `numericId`, no wiki page. Stored in the entities table for directory/personnel use but are lightweight. Use `crux tb ensure-entities` or `crux tb create-entity` for these.
  - All stableIds use the `sid_` prefix format. Use `isSid()` from `@longterm-wiki/id-utils` to detect them.
  - **Never manually invent IDs** — use the functions above.
- **Hono RPC**: Mandatory for new wiki-server routes — use method-chaining (`const app = new Hono().get(...).post(...)` + `export type Route = typeof app`). See the `/agent-review-pr` skill ("Code review rules to enforce") for the full code-review rule set.
- **Content pages use local data**: Wiki pages read `database.json` — zero runtime API calls. Only internal dashboards make live wiki-server requests.
- **API keys**: In environment variables, NOT `.env` files. Required: `ANTHROPIC_BILLING_KEY`, `OPENROUTER_API_KEY`. Named `BILLING` (not `API_KEY`) so the `claude` CLI — which auto-reads `ANTHROPIC_API_KEY` — can never silently pick up the billing key and bypass OAuth. See [QUA-612](https://linear.app/quantifieduncertainty/issue/QUA-612).
- **Wiki-server from agent slots (auto-prod, QUA-616)**: Agent slots (`lw/a1`–`lw/a20`) do NOT run a local wiki-server. Crux now **auto-detects that CWD is inside a slot and forces `WIKI_SERVER_ENV=prod`** — you no longer need to prefix every command with `WIKI_SERVER_ENV=prod`. The manual prefix still works and takes precedence; set `WIKI_SERVER_ENV=local` to force local from inside a slot (e.g. when testing against a locally-run wiki-server). The prod wiki-server at `wiki-server.k8s.quantifieduncertainty.org` is always available.
- **No new bash scripts**: Write new scripts/tools as TypeScript in `crux/`. Bash is only acceptable for git hooks (`.githooks/`), Claude Code hooks (`.claude/hooks/`), and CI glue where Node.js isn't available.

## Tier 1 — Always-loaded session rules (`.claude/rules/`)

These cover the session lifecycle and the always-applicable conventions. They auto-load on every turn.

- `.claude/rules/agent-session-workflow.md` — Session start/end workflow
- `.claude/rules/agent-planning-discipline.md` — Multi-week plans require human framing approval, empirical evidence before scope, ≥3 diverse-mandate reviewers (QUA-1045)
- `.claude/rules/environment-setup.md` — Worktree, LSP, slot ports, wiki-server auto-prod
- `.claude/rules/github-issue-tracking.md` — Issue tracking (Linear primary, GitHub legacy)
- `.claude/rules/proactive-github-filing.md` — When/how to file issues (in Linear)
- `.claude/rules/session-logging.md` — Session log format and storage
- `.claude/rules/error-handling.md` — Error handling strategy and `.catch()` patterns
- `.claude/rules/implementation-quality.md` — Thoroughness, testing depth, self-review
- `.claude/rules/slot-isolation.md` — Don't touch other agent slots
- `.claude/rules/worktree-isolation-bug.md` — Known Claude Code worktree CWD bug (DO NOT USE `isolation: "worktree"`)
- `.claude/rules/wait-on-subagents.md` — Use `Monitor` to wait on dispatched subagents; `cat`-polling is hook-blocked at 3 occurrences (QUA-1069)

Phase-loaded guidance (only fires when the corresponding skill runs):

- `/agent-ship` — Pre-PR build/test/gate/Playwright verification, PR-body shell safety, GitHub auto-close syntax, post-merge audit entries, the "do not offer /schedule" rule (was: `pr-review-guidelines.md`, `pre-pr-verification.md`)
- `/agent-push-and-verify` — CodeRabbit "Addressed in commit X" markers — DO NOT TRUST; push-failure detection
- `/agent-review-pr` — Code review rules (no `(r: any)`, Hono RPC, typed clients, batch endpoints, etc.)
- `/page-authoring` — Crux content pipeline, post-edit fixes, page self-review checklist

## Tier 2 — Subsystem maps (read on-demand, NOT auto-loaded)

These live in `docs/agent-rules/`. They are **NOT** auto-loaded — to keep cache cost down, the agent must `Read` the relevant map at task-start when its work touches that subsystem. **MANDATORY: if your task lands in any row below, your first action after `agent-checklist init` is to Read the map.** Each map opens with "Read this before X" — that "X" describes when it applies.

| When your task touches… | Read first |
|---|---|
| Linear issue lifecycle, branch naming `qua-NNN`, `crux linear` commands | `docs/agent-rules/linear-integration.md` |
| Filing a new Linear ticket — picking the right project | `docs/agent-rules/linear-project-ownership.md` |
| Filing a Linear ticket — sizing red flags | `docs/agent-rules/ticket-sizing.md` |
| Database migrations (any `apps/wiki-server/drizzle/*.sql`) | `docs/agent-rules/database-migrations.md` |
| PG audit triggers, `full_audit_log`, `tablebase_audit_log` | `docs/agent-rules/audit-log.md` |
| TableBase sync routes (`apps/wiki-server/src/routes/tablebase/`) | `docs/agent-rules/tablebase-sync-factory.md` |
| TableBase / FactBase / WikiBase naming, which layer owns what | `docs/agent-rules/three-bases-architecture.md` |
| Source-check verdicts, coverage scoring, `/api/sourcing/*`, dot indicators | `docs/agent-rules/source-check-system.md` |
| `numericId` vs `stableId` vs `tableId` — allocation, validation | `docs/agent-rules/id-system.md` |
| Adding/changing a `crux/validate/` validator or the gate | `docs/agent-rules/validation-gate-system.md` |
| Editing improve-entity pipeline files (research/**, claim-sourcing, entity-suite.yaml) — CI gate fires | `docs/agent-rules/improve-pipeline-benchmark-gate.md` |
| Entity profile pages (`/organizations/[slug]`, `/people/[slug]`, etc.) | `docs/agent-rules/entity-profile-pages.md` |
| Adding a new internal dashboard (`/internal/*`) | `docs/agent-rules/internal-dashboards.md` |
| Auto-update system (cron, news pipeline) | `docs/agent-rules/auto-update-system.md` |
| LLM prompt construction — escaping user content | `docs/agent-rules/llm-prompt-safety.md` |
| Dispatching subagents from a coordinator session | `docs/agent-rules/dispatched-agent-review.md` |
| PR patrol — health gate, fleet-level signals | `docs/agent-rules/patrol-health-gate.md` |

Plus historical: `docs/audits/things-denormalization-audit.md` (denorm columns dropped in QUA-507 / migration 0204; retained for pre-QUA-507 composer logic per thing_type and for the `*_display_name` sibling pattern audit before proposing a new cache column).

> **Why this split (QUA-949):** before this restructure, every Tier 2 map auto-loaded on every turn — ~55k tokens of subsystem reference manuals consumed even when the task didn't touch them. Moving them out of `.claude/rules/` cuts cache cost ~60% while keeping the table above as the explicit "go read X" pointer.
