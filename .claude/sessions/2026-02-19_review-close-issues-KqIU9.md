## 2026-02-19 | claude/review-close-issues-KqIU9 | Fix triage-issues: use explicit closes #N instead of keyword matching

**What was done:** Fixed `crux maintain triage-issues` to use explicit `closes/fixes/resolves #N` references in merged PR bodies as the only signal for "potentially resolved" issues. Previously it used 60% keyword-overlap matching against PR titles and session logs, causing ~97% false positive rate (29/30 issues flagged). Now 0 false positives — only issues explicitly closed by a merged PR appear in that category.

**Pages:** (none)

**Model:** sonnet-4

**Duration:** ~20min

**Issues encountered:**
- `GitHubPullResponse` interface was missing the `body` field, so PR bodies were never fetched — had to add it to the type.
- Pre-existing TypeScript errors in other crux files (unrelated to this change) — no new errors introduced.

**Learnings/notes:**
- The `--since` option was being parsed but only used to load session logs (which were then used for keyword matching). After removing keyword matching, both became dead code and were removed from `triageIssues`.
- `isLikelyReferenced` and `tokenize` helpers are now fully unused and were deleted.
