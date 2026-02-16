## 2026-02-16 | claude/review-recent-prs-Z1dC2 | Review PRs + add pre-push gate

**What was done:** Reviewed PRs #142-#160 (15 PRs) for improvement patterns, then added `crux validate gate` command and `.githooks/pre-push` hook to mechanically enforce CI-blocking checks before every push. Added `prepare` script to auto-configure hooks on `pnpm install`.

**Pages:** (none — infrastructure only)

**Issues encountered:**
- None

**Learnings/notes:**
- Gate check runs 5 steps in ~33s: build-data, tests, MDX syntax, YAML schema, frontmatter schema
- `--full` flag adds Next.js production build (~2-3min extra)
- Hook auto-activates via `prepare` script on `pnpm install` — no manual setup needed
- NumericId conflicts are the dominant recurring problem (6+ fix commits in review window)
- Crux pipeline is non-functional in Claude Code web sessions (3 sessions hit this)
