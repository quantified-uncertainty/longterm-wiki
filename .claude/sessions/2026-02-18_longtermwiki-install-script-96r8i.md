## 2026-02-18 | claude/longtermwiki-install-script-96r8i | Add development setup script

**What was done:** Created `scripts/setup.sh` install script that automates the full dev environment setup: prerequisite checks (Node ≥20, pnpm ≥9), dependency installation, data layer build, git hooks configuration, env var verification, and validation gate. Supports `--quick` (skip validation), `--check` (dry-run diagnostics), and full modes. Added `pnpm setup` / `pnpm setup:quick` / `pnpm setup:check` npm scripts.

**Model:** opus-4-6

**Duration:** ~20min

**Issues encountered:**
- Puppeteer postinstall fails in sandboxed environments (no network access to download Chrome). Solved by setting `PUPPETEER_SKIP_DOWNLOAD=1` during install since Chrome is only needed for screenshot tests.

**Learnings/notes:**
- `database.json` strips raw `entities` in favor of `typedEntities` — use `typedEntities` key when reading entity counts
- The `prepare` script in package.json already runs `git config core.hooksPath .githooks` on install, but the setup script verifies this explicitly
