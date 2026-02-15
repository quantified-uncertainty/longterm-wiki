## 2026-02-15 | claude/review-pr-logs-mU1tc | Review last 20 PR session logs

**What was done:** Reviewed session logs and GitHub PR metadata for the last 20 merged PRs (Feb 13–15). Compiled a summary of pages created/edited, infrastructure changes, notable recurring issues (crux pipeline synthesis broken, linter reassigning entity IDs, valuation inconsistencies across page clusters, session log migration breaking data pipeline), and aggregate stats (20 PRs, ~30+ pages edited, 4 new wiki pages, 2 new data layers, 3 new CLI tools).

**Pages:** (no wiki content pages changed — review-only session)

**Issues encountered:**
- None

**Learnings/notes:**
- The crux content pipeline synthesis step is the most frequently reported failure across sessions — it affects nearly every page creation task
- Entity ID reassignment by the linter is a subtle and dangerous issue that has caused cross-page breakage
- The `replace_all` tool on short strings (like `E6`) can match unintended targets (like `E64`)
