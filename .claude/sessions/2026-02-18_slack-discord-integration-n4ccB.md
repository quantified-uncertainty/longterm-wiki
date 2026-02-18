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
