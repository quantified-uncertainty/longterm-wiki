## 2026-02-19 | claude/review-close-issues-KqIU9 | Issue triage: nothing to close

**What was done:** Ran `pnpm crux maintain triage-issues` and manually verified each of the 29 "potentially resolved" flags against the codebase. Found that all flags were false positives from loose keyword matching — no issues were actually implemented-but-not-closed. Reported findings to user including 5 in-progress issues (claude-working) and 2 edge cases requiring maintainer judgment (#283 GITHUB_TOKEN deployment, #162 LLM quality gates).

**Pages:** (none — research-only session)

**Model:** sonnet-4

**Duration:** ~15min

**Issues encountered:**
- `pnpm crux maintain triage-issues` has a ~97% false positive rate (29/30 flagged, ~0 actually resolved). It uses keyword matching against session logs/PR titles instead of requiring explicit `closes #N` references in PR bodies.

**Learnings/notes:**
- All 30 open issues are legitimately open. The only ones with active work are #254, #281, #293, #299, #202 (claude-working label).
- GitHub's auto-close-on-PR-merge is working correctly — all PRs with `closes #N` properly closed their referenced issues.
- The `triage-issues` command should be improved to use `closes #N` reference matching rather than keyword overlap.

**Recommendations:**
- Fix `crux/commands/maintain.ts` triage-issues logic to require explicit `closes #N` PR body references for high-confidence "resolved" detection, and downgrade keyword-only matches to a separate lower-confidence category.
