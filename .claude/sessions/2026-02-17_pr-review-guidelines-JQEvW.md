## 2026-02-17 | claude/pr-review-guidelines-JQEvW | Add mandatory PR review & ship workflow rule

**What was done:** Created `.claude/rules/pr-review-guidelines.md` that makes Claude automatically run `/paranoid-pr-review` → `/push-and-ensure-green` → conflict check at end of every session. Renamed commands from `review.md`/`push-safe.md` to `paranoid-pr-review.md`/`push-and-ensure-green.md` to avoid collisions with built-in Claude Code skills. Fixed `push-and-ensure-green` to use `curl`+`GITHUB_TOKEN` instead of `gh` CLI (which isn't available). Added reference in CLAUDE.md.

**Pages:** (none — infrastructure-only)

**Issues encountered:**
- Built-in Claude Code skills named `review` and `push-safe` collide with project commands of the same name, causing duplicate entries in the slash command picker. Fixed by renaming to descriptive names.

**Learnings/notes:**
- `.claude/rules/` files are auto-loaded and enforced without user prompting — ideal for mandatory workflows
- `.claude/commands/` filenames should avoid generic names that conflict with built-in skills (`review`, `push-safe`, etc.)
- `gh` CLI is not available in web environments — always use `curl` with `$GITHUB_TOKEN` for GitHub API calls
