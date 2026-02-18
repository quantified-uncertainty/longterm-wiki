## 2026-02-18 | claude/slack-discord-integration-n4ccB | Move discord-bot into apps/

**What was done:** Moved `discord-bot/` → `apps/discord-bot/` and updated `pnpm-workspace.yaml`. Fixed `WIKI_ROOT` path comment in `config.ts` (the `../../..` resolve was already correct for the new depth, but the comment was wrong).

**Pages:** none

**Model:** sonnet-4

**Duration:** ~10min

**Issues encountered:**
- `git mv` failed with cross-device link error; used `cp -r` + `git rm` + `git add` instead

**Learnings/notes:**
- After the move, `resolve(__dirname, "../../..")` from `apps/discord-bot/src/` now correctly reaches the repo root (was one level too far before)
- Filed issue for the full `app/` → `apps/web/` rename

---

## 2026-02-18 | claude/slack-discord-integration-n4ccB | PR review fixes

**What was done:** Paranoid review of the full discord-bot PR. Fixed 4 issues found: (1) ArgoCD CLI now downloads from pinned GitHub release instead of `ARGOCD_SERVER` (security); (2) `formatCost` sub-cent display bug (`$0.50¢` → `0.50¢`); (3) added discord-bot typecheck step to CI workflow; (4) fixed missing trailing newline in sources.yaml. Filed 4 GitHub issues for remaining items (#286 ops deployment, #287 rate limiting, #288 ephemeral logs, #289 unit tests).

**Pages:** none

**Model:** sonnet-4

**Duration:** ~20min

**Issues encountered:**
- None

**Learnings/notes:**
- The ArgoCD binary download pattern (from own server) is a common CI antipattern — always download from GitHub releases with a pinned version
- discord-bot tests are purely integration (real API); consider adding vitest unit tests for pure functions (issue #289)
