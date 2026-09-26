# Longterm Wiki

AI-safety wiki: ~780 MDX pages, a YAML data layer, a Next.js 15 site, a
Hono/Drizzle/Postgres API ("wiki-server"), and the `crux` CLI that validates,
generates and syncs it all. Production: `https://www.longtermwiki.com`
(never `longterm.wiki` or `longtermwiki.org`). "Open Philanthropy" is now
called **Coefficient Giving** in all content.

## Repo map

| Path | What |
|---|---|
| `content/docs/` | MDX wiki pages |
| `data/entities/*.yaml` | Entity catalog (orgs, people, models, concepts…) |
| `data/*.yaml` | Glossary, experts, literature and other catalogs |
| `packages/factbase/data/fb-entities/` | FactBase: structured, dated facts per entity |
| `apps/web/` | Next.js site (has its own `CLAUDE.md`) |
| `apps/wiki-server/` | API + Postgres schema (`src/schema.ts`) and migrations (`drizzle/`) |
| `crux/` | CLI: `pnpm crux --help`, `pnpm crux <group> --help` |
| `.claude/commands/` | Slash commands (`/page-authoring`, `/agent-review-pr`, …) |
| `docs/agent-rules/` | On-demand reference docs (table below) |

## Where data lives (who is authoritative)

`apps/web/scripts/build-data.mjs` builds `apps/web/src/data/database.json`,
which pages read at build time (no runtime API calls from wiki pages).

- **Authored in git, mirrored to PG**: entities (`data/entities/`) and
  FactBase facts (`fb-entities/`). CI syncs them to the PG `entities` /
  `facts` tables on merge; the full build reads facts back from PG when
  reachable. Edit the YAML, never the PG copy.
- **PG only** (via wiki-server, no YAML source): resources, grants,
  personnel, funding rounds, investments, equity positions, divisions,
  funding programs, publications, entity events/assessments, benchmark
  results, research areas, record verdicts. Change these through the API /
  `pnpm crux tb …`, not by adding YAML.
- **Pages**: MDX in `content/docs/`.
- New features with their own directory page or aggregatable numeric data
  go in PG tables, not YAML.
- `--scope=content` builds skip every PG fetch, so that data is simply
  absent locally without server credentials; that is expected.

Naming: TableBase = PG entities/records; FactBase = dated triples;
WikiBase = MDX prose. The PG `things` table is a cross-base search index.

## Commands

```bash
pnpm setup:quick                     # install + build data (first run)
pnpm build-data:content              # rebuild database.json, no server needed
pnpm dev                             # site on $DEV_PORT (default 3001)
pnpm test                            # all vitest suites; pnpm test:crux for crux only
cd apps/web && npx tsc --noEmit      # web typecheck
cd apps/wiki-server && npx tsc --noEmit   # wiki-server typecheck
pnpm crux w fix escaping             # run after editing any MDX
pnpm crux w fix markdown             # run after editing any MDX
pnpm crux w validate gate --scope=content --fix   # fast content gate (~15s)
pnpm crux w validate gate --fix      # full pre-push gate (the git pre-push hook runs it)
```

Commands that talk to the wiki-server need `LONGTERMWIKI_SERVER_URL` /
`..._API_KEY` (or the `PROD_` pair with `WIKI_SERVER_ENV=prod`). Without
them, `tb ids allocate`, `query`, `context` and sourcing checks fail; say so
rather than working around it.

## Hard rules

- **Never push to `main` or `production`.** Work on a branch, open a PR.
  Production deploys are a release PR `main` → `production` (`/deploy`), and
  merging it runs wiki-server migrations against the prod DB.
- **Never `--no-verify`** a commit or push; the pre-push gate is the check.
- **MDX escaping**: `\$100`, not `$100`; `\<100ms`, not `<100ms`. The fix
  commands above handle most cases.
- **Never invent IDs.** Wiki entities get `numericId` + `stableId` from
  `pnpm crux tb ids allocate <slug>`; lightweight records get a `sid_…`
  stableId via `crux tb ensure-entities` / `generateId()`. Read
  `docs/agent-rules/id-system.md` first.
- **Migrations** (`apps/wiki-server/drizzle/*.sql`): never edit one that has
  merged; enumerate prod values before a CHECK constraint; use `NOT VALID`
  + `VALIDATE` on large tables. Read `docs/agent-rules/database-migrations.md`
  before writing any.
- **FactBase facts** are the only structured-fact source: use `<FBF>` /
  `<FBFactValue>` / `<Calc>` in MDX, not hard-coded numbers.
- New wiki-server routes use Hono RPC method-chaining and export
  `type XRoute = typeof app`.
- No silent `.catch(() => {})`: log, rethrow, or comment why not.
- API keys come from the environment (`ANTHROPIC_BILLING_KEY`,
  `OPENROUTER_API_KEY`), never committed `.env` files.
- Do not use `isolation: "worktree"` for subagents (a Claude Code bug
  deletes the parent's working directory).
- Never kill processes you did not start (`pkill node` / `pkill next` can
  take down the owner's dev server).
- Bug fixes: reproduce first (a failing test or check), then fix.
- New scripts are TypeScript under `crux/`, not bash.

## On-demand docs (read when the task touches the subject)

| Subject | Read |
|---|---|
| Editing wiki pages | `/page-authoring`, `content/docs/internal/` style guides |
| IDs | `docs/agent-rules/id-system.md` |
| Migrations, audit log | `docs/agent-rules/database-migrations.md`, `audit-log.md` |
| TableBase / FactBase / WikiBase | `docs/agent-rules/three-bases-architecture.md`, `content/docs/internal/data-architecture.mdx` |
| TableBase sync routes | `docs/agent-rules/tablebase-sync-factory.md` |
| Source-checking, verdicts | `docs/agent-rules/source-check-system.md` |
| Validators and the gate | `docs/agent-rules/validation-gate-system.md` |
| Entity profile pages, `/internal/*` dashboards | `docs/agent-rules/entity-profile-pages.md`, `internal-dashboards.md` |
| Improve-entity pipeline | `docs/agent-rules/improve-pipeline-benchmark-gate.md` |
| LLM prompts with user content | `docs/agent-rules/llm-prompt-safety.md` |
| `postinstall` / Dockerfiles | `docs/agent-rules/dockerfile-postinstall-trap.md` |
| Error handling, test depth | `docs/agent-rules/error-handling.md`, `implementation-quality.md` |
| Linear issues and filing | `docs/agent-rules/github-issue-tracking.md`, `proactive-github-filing.md`, `linear-integration.md` |
| Multi-week plans | `docs/agent-rules/agent-planning-discipline.md` |
| Gotchas learned the hard way | `.claude/memory/MEMORY.md` |
| Running many agents in parallel slots | `docs/agent-rules/fleet-mode.md` |
