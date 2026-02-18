# Common Issues & Solutions

Recurring problems encountered across Claude Code sessions. When you hit a known issue, check here first. When you discover a new recurring issue, add it here.

---

## Build & CI

### Data layer must be built before tests or app build
`node app/scripts/build-data.mjs` must run before `pnpm test` or `pnpm build`. If tests fail with missing data errors, this is likely why.

### API keys are in environment, not .env files
Check `env | grep -i API` — keys are set as environment variables, not in `.env` files. Required: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`.

### CI verification requires curl, not gh
`gh` CLI is not installed. Use `curl` with `$GITHUB_TOKEN` to check CI status (see CLAUDE.md for the exact command).

---

## Page Authoring

### Always use the Crux pipeline, never write pages manually
If `pnpm crux content create` or `pnpm crux content improve` fails, fix the pipeline — don't bypass it. See CLAUDE.md for details.

### Run escaping fixes after any page edit
```bash
pnpm crux fix escaping
pnpm crux fix markdown
pnpm crux validate unified --rules=comparison-operators,dollar-signs --errors-only
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

---

## Environment Detection

### Crux content pipeline auto-detects API-direct mode
When running inside Claude Code SDK (web sessions), the `CLAUDECODE` env var is set. The pipeline automatically switches from spawning `claude` CLI subprocesses to calling the Anthropic API directly. If synthesis hangs despite this, verify with `echo $CLAUDECODE` and check that `shouldUseApiDirect()` in `crux/lib/claude-cli.ts` returns `true`.

---

_Add new issues below as they're discovered. Group by category._
