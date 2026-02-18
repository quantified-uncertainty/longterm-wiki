## 2026-02-18 | claude/resolve-issue-248-ZKWIC | Break up oversized crux files

**What was done:** Further split two remaining oversized modules from the initial Phase 3 refactoring (commit 948e535). Extracted `grading/index.ts` (488→326 lines) into `pages.ts`, `apply.ts`, `stats.ts`; split `link-checker/checkers.ts` (463→12 lines shim) into `strategies.ts`, `batch.ts`, `archive.ts`. All modules now under 330 lines.

**Model:** opus-4-6

**Duration:** ~20min

**Issues encountered:**
- None

**Learnings/notes:**
- The original 1000+ line files had already been split into directories in commit 948e535, but two modules within those directories (grading/index.ts at 488 lines, link-checker/checkers.ts at 463 lines) remained oversized
- Backward-compatible re-export shims preserve existing import paths
