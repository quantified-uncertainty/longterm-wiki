## 2026-02-16 | claude/review-recent-prs-Z1dC2 | Review PRs + add pre-push gate

**What was done:** Reviewed PRs #142-#160 (15 PRs) for improvement patterns, then added `crux validate gate` command and `.githooks/pre-push` hook to mechanically enforce CI-blocking checks before every push.

**Pages:** (none — infrastructure only)

**Issues encountered:**
- None

**Learnings/notes:**
- Gate check runs 5 steps in ~33s: build-data, tests, MDX syntax, YAML schema, frontmatter schema
- `--full` flag adds Next.js production build (~2-3min extra)
- Activate hook with: `git config core.hooksPath .githooks`
- NumericId conflicts are the dominant recurring problem (6+ fix commits in review window)
- Crux pipeline is non-functional in Claude Code web sessions (3 sessions hit this)
