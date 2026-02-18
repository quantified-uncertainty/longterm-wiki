## 2026-02-18 | claude/convert-proposed-issues-kJbvc | Convert cruft files to GitHub issues

**What was done:** Audited 6 cruft files at the repo root and in crux/TODO.md. Created 11 GitHub issues from still-actionable findings, added XS/S/M/L/XL size labels to the repo, then deleted the source files (AUDIT-REPORT.md, AUDIT-EXECUTION-SUMMARY.md, CODE-REVIEW.md, DEAD-CODE-REPORT.md, STARLIGHT-CLEANUP-PLAN.md, crux/TODO.md).

**Pages:** None

**Model:** sonnet-4-6

**Duration:** ~20min

**Issues encountered:**
- gh CLI not available; used GitHub REST API via curl
- Many items in the cruft files were already resolved — checked before creating issues to avoid duplicates

**Learnings/notes:**
- DEAD-CODE-REPORT items mostly already cleaned up (orphaned files gone, master-graph-data.ts down from ~1400 to 97 lines)
- STARLIGHT-CLEANUP-PLAN mostly done — only 15 files still have pageTemplate frontmatter
- CODE-REVIEW #1 (withRetry) and #3 (frontmatter-scanner directories) already fixed
- crux/TODO.md items 1-5 all done, only item 6 remained (entityType migration)
