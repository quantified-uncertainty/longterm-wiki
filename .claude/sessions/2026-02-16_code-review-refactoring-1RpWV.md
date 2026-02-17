## 2026-02-16 | claude/code-review-refactoring-1RpWV | Code review + Phase 1-3 refactoring

**What was done:** Conducted comprehensive code review (CODE-REVIEW.md) identifying 26 refactoring opportunities. Implemented Phases 1-3:

Phase 1 (quick wins):
1. Extracted `withRetry`/`startHeartbeat` to shared `crux/lib/resilience.ts`
2. Created `TOP_LEVEL_CONTENT_DIRS` constant, fixing frontmatter-scanner.mjs bug
3. Added YAML parse error handling in build-data.mjs
4. Added error state + fallback in CauseEffectGraph layout failures
5. Replaced `any` types with proper types in remark-callouts.ts and data/index.ts

Phase 2 (extract shared libs):
1. Unified metrics-extractor: backported format-aware scoring to TS, eliminated 370-line .mjs duplicate
2. Added `formatTime` + `createPhaseLogger` to crux/lib/output.ts
3. Created shared `CreatorContext` type in crux/authoring/creator/types.ts
4. Made crux.mjs use shared `parseCliArgs` from cli.ts
5. Extracted entity-type-mappings.mjs as single source of truth

Phase 3 (break up large files — 4,716 lines removed from monolithic files):
1. CauseEffectGraph (716→411 lines): Extracted `graph-algorithms.ts`, `graph-export.ts`, `styled-elements.ts`
2. TransitionModelTableClient (792→317 lines): Extracted `TransitionModelHelpers.tsx`, `TransitionModelColumns.tsx` with unified column factory
3. page-improver.ts (1710 lines): Split into `page-improver/` directory with types.ts, utils.ts, api.ts, phases.ts, pipeline.ts, index.ts
4. grade-content.ts (1109 lines): Split into `grading/` directory with types.ts, prompts.ts, steps.ts, index.ts
5. check-links.ts (1073 lines): Split into `link-checker/` directory with types.ts, collectors.ts, checkers.ts, report.ts, index.ts

All original files replaced with backward-compatible shims. Command references updated.

**Issues encountered:**
- Pre-existing numericId conflicts in build-data (E698-E708) not related to our changes
- validate-entities.test.ts fails without database.json (pre-existing)

**Learnings/notes:**
- Build scripts now use `node --import tsx/esm` to enable TS imports from crux/
- metrics-extractor.mjs can now be deleted in a follow-up cleanup
- Shim pattern works well for subprocess-invoked scripts: original file just re-exports + delegates
- All 358 tests pass (288 crux + 70 app), all CI validations pass, full build succeeds
