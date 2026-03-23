# Common Issues & Solutions

Recurring problems encountered across Claude Code sessions. When you hit a known issue, check here first. When you discover a new recurring issue, add it here.

---

## Build & CI

### Data layer must be built before tests or app build
The data layer must be built before `pnpm test` or `pnpm build`. If tests fail with missing data errors, run `pnpm run --filter longterm-next sync:data`. Note: `build-data.mjs` uses `process.cwd()` for path resolution and must be run from `apps/web/` (the pnpm filter handles this).

### API keys are in environment, not .env files
Check `env | grep -i API` — keys are set as environment variables, not in `.env` files. Required: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`.

### OpenRouter model IDs can be deprecated without warning
Model IDs like `google/gemini-flash-1.5` get removed from OpenRouter. When a pipeline call returns a model-not-found error, check the [OpenRouter models page](https://openrouter.ai/models) for the current ID. As of Feb 2026, Gemini Flash is `google/gemini-2.0-flash-001`.

### CI verification requires curl, not gh
`gh` CLI is not installed. Use `curl` with `$GITHUB_TOKEN` to check CI status (see CLAUDE.md for the exact command).

---

## Page Authoring

### Always use the Crux pipeline, never write pages manually
If `pnpm crux w content create` or `pnpm crux w content improve` fails, fix the pipeline — don't bypass it. See CLAUDE.md for details.

### Run escaping fixes after any page edit
```bash
pnpm crux w fix escaping
pnpm crux w fix markdown
pnpm crux w validate unified --rules=comparison-operators,dollar-signs --errors-only
```

---

## MDX & Rendering

### Dollar signs must be escaped
Use `\$100` not `$100` in MDX files. The unified validator catches this.

### Comparison operators must be escaped
Use `\<` not `<` in prose (outside of JSX tags). The unified validator catches this.

---

## Git & Branches

### Branch naming for Claude Code web sessions
Branches must start with `claude/` and end with the session ID, otherwise push fails with 403.

### "ahead N, behind M" diverged branch state
When `git status -b --short` shows `[ahead 3, behind 23]`, it means the auto-rebase GitHub Actions workflow already rebased the remote branch onto main (force-pushing to origin), but the local session still has the old (pre-rebase) commits.

**Fix:** Run `git pull --rebase` to rebase local commits onto the updated remote. Then push with `git push --force-with-lease -u origin HEAD` (force-with-lease is required because the rebase rewrote history).

This is handled automatically by the `/push-and-ensure-green` Step 0 workflow. If `git pull --rebase` succeeds cleanly (no conflicts), no manual conflict resolution is needed — the auto-rebase workflow already incorporated your commits on top of main on the remote side.

---

## Dependencies

### Puppeteer download fails in sandboxed environments
`pnpm install` fails because Puppeteer tries to download a Chrome binary. This affects ~50% of sessions. The setup script handles this automatically, but if running `pnpm install` directly, use:
```bash
PUPPETEER_SKIP_DOWNLOAD=1 pnpm install
```
Puppeteer is only needed for screenshot tests, not core development.

### better-sqlite3 may need native module rebuild
If you get errors about `better-sqlite3` native bindings, run:
```bash
npx node-gyp rebuild
```

### better-sqlite3 cannot be imported in Next.js app code
Next.js apps cannot import native Node modules like `better-sqlite3` directly — they're not available at build/runtime in the Next.js environment. Use a JSON export approach instead: have a crux script write data to a `.json` or `.cache/` file, then read that from the Next.js server component via `fs`.

---

## Network / Proxy

### Next.js server-side fetch() ignores HTTPS_PROXY by default
Node.js's built-in `fetch()` (undici) does NOT respect `HTTPS_PROXY`/`HTTP_PROXY` env vars unless `NODE_USE_ENV_PROXY=1` is set. This causes silent failures when any server component makes outbound HTTP calls (e.g. the GitHub Issues dashboard). The flag is a no-op when no proxy is configured, so it's safe to include unconditionally in `dev`/`build`/`start` scripts in `apps/web/package.json`.

The `crux` CLI already sets this via `NODE_USE_ENV_PROXY=1 node ...` in the root `package.json`.

---

## Environment Detection

### Crux content pipeline auto-detects API-direct mode
When running inside Claude Code SDK (web sessions), the `CLAUDECODE` env var is set. The pipeline automatically switches from spawning `claude` CLI subprocesses to calling the Anthropic API directly. If synthesis hangs despite this, verify with `echo $CLAUDECODE` and check that `shouldUseApiDirect()` in `crux/lib/claude-cli.ts` returns `true`.

---

## Crux / CLI Modules

### Add `process.argv[1]` guard to any module with a top-level `main()` call
If a crux/validate script calls `main()` at module level (not inside a `__main__`-equivalent guard), it will execute during test imports and cause `process.exit()` side-effects or timing errors. Fix:
```ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
```
Required on any script where `main()` was previously called at the bottom of the file unconditionally.

### SQLite `SUM()` returns null on empty tables
Use `COALESCE(SUM(col), 0)` for display-facing queries. `SUM()` over zero rows returns SQL `NULL`, not `0`.

---

## Content / Citations

### Pages with footnote definitions but no inline refs produce no quote results
Some pages list sources as `[^N]: [Title](URL)` at the bottom but never reference `[^N]` inline in the prose. The citation pipeline extracts no quotes from these pages because there's no claim context. Flag these pages for inline-citation cleanup — the sources are there, they just need to be referenced.

### `process.cwd()` in Next.js server components resolves to `apps/web/`
When reading files from Next.js server components using relative paths, `process.cwd()` resolves to `apps/web/`, not the workspace root. So `../../data/` reaches the root `data/` directory and `../../.cache/` reaches the root `.cache/` directory. Keep this in mind when constructing paths in server components.

### Sandbox blocks most external URL fetches
Inside Claude Code sandboxed environments, outbound HTTP fetches fail. For citation pipeline runs (`crux w citations verify`, `crux w citations extract-quotes`), you may need `dangerouslyDisableSandbox: true` when using the Bash tool. This is expected — the sandbox prevents web access by default.

---

---

## Auto-Update Pipeline

### Improve pipeline may strip `title` from frontmatter on complex pages
When the LLM improve pipeline rewrites large, complex pages (e.g. `language-models.mdx`), it sometimes returns content without the `title` field in the frontmatter. This causes the frontmatter-schema gate check to fail with `title: Required (got: undefined)`, blocking the auto-update PR from merging.

**Observed**: 5+ consecutive `auto-update.yml` failures (2026-03-09 to 2026-03-12). Issue #2117 tracks the fix.

**Workaround**: If a page is repeatedly breaking auto-update, add it to the excluded list in the auto-update config, or ensure the improve pipeline prompt explicitly preserves all frontmatter fields.

### Artifacts API `directions` field has 5000-char limit
When auto-update generates directions for future runs, the LLM may produce more than 5000 characters. The artifact save call returns `400: String must contain at most 5000 character(s)` for the `directions` field. **Fixed** in PR #2194: truncation added in `page-router.ts`, `orchestrator.ts`, and `pipeline.ts`.

### Pre-push hook blocks CI auto-update push
The `.githooks/pre-push` hook runs `crux w validate gate`, which re-runs the full gate check on push. In CI auto-update, the gate already runs in Step 3, so re-running it at push time adds 5+ minutes and can fail on pre-existing issues in unrelated files. **Fixed** in PR #2206: CI orchestrator uses `--no-verify` on push and a Step 3b reverts pages with unresolvable validation errors.

---

_Add new issues below as they're discovered. Group by category._

---

## Entity References

### EntityLink must use E-numbers, not slugs — breaks main CI
`<EntityLink id="some-slug">` fails at build time if the entity has a numeric wiki ID (E-number). Always use `<EntityLink id="E123">` format. Using slug-based IDs (e.g. `id="anthropic"`) causes build failures that break main CI.

**Pattern**: When creating or improving pages that reference entities, look up the entity's `wikiId` (e.g. `E42`) from `data/entities/*.yaml` and use that. Run `pnpm crux w validate gate --fix` to catch these before committing.

**Observed**: PRs #2960, #2961 both fixed CI breakage from slug-based EntityLink IDs on the same day (2026-03-22). This is a recurring pattern.

---

## Database Migrations

### Migration journal tag index conflicts break main CI
When multiple feature branches each add a Drizzle migration and are merged in sequence, the migration journal (`apps/wiki-server/drizzle/meta/_journal.json`) can end up with duplicate `idx` values or wrong sequential indices. This causes the wiki-server to fail on startup and breaks all CI.

**Fix**: Find the conflicting entry (search for duplicate idx values in `_journal.json`), correct the `idx`, and rename the `.sql` file prefix to match. See PRs #2967, #3029 for examples.

**Prevention**: After merging a PR that adds a migration, immediately check that `_journal.json` has no duplicate indices before opening the next migration PR.

### wikiId collisions break main CI build (!! RECURRING)
Adding a new entity with a `wikiId` that's already used by another entity causes `next build` to fail. Three CI breakages in two days (PRs #2948, #2958, #3027 on 2026-03-21/22).

**Fix**: Run `pnpm crux w validate gate` to detect collisions. Use `pnpm crux tb ids allocate <slug>` to get a guaranteed-unique ID.

**Prevention**: Always allocate IDs with `crux tb ids allocate` rather than manually picking a number. Never reuse an ID from a "deprecated" page. The gate check detects collisions — run it before committing any new entity.
