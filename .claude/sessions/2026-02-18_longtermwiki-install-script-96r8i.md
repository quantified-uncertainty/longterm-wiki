## 2026-02-18 | claude/longtermwiki-install-script-96r8i | Developer experience improvements

**What was done:** Created `scripts/setup.sh` install script and six follow-up DX improvements: (1) `.nvmrc` for Node version auto-switching, (2) puppeteer + sqlite3 issues documented in common-issues.md, (3) SessionStart hook (`.claude/settings.json` + `.claude/hooks/session-start.sh`) to auto-install deps and build data layer on session start, (4) auto-build in crux `loadGeneratedJson()` when data layer is missing, (5) `.githooks/post-merge` hook to rebuild data after pulls, (6) fixed synthesis subprocess hang by detecting `CLAUDECODE` env var in `shouldUseApiDirect()`.

**Model:** opus-4-6

**Duration:** ~45min

**Issues encountered:**
- Puppeteer postinstall fails in sandboxed environments (no network access to download Chrome). Solved by setting `PUPPETEER_SKIP_DOWNLOAD=1` during install.

**Learnings/notes:**
- `CLAUDECODE=1` is set in Claude Code SDK sessions; `claude --version` succeeds but actual synthesis subprocesses hang indefinitely — checking the env var is more reliable than binary detection
- The api-direct mode already existed in full (`synthesis`, `validation-loop`, `review`) — just needed better auto-detection
- 8 of 20 recent sessions hit puppeteer download failures; documenting this should reduce wasted troubleshooting time
- `database.json` strips raw `entities` in favor of `typedEntities` — use `typedEntities` key when reading entity counts
