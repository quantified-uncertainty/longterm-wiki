## 2026-02-16 | claude/code-review-refactoring-1RpWV | Code review + Phase 1 & 2 refactoring

**What was done:** Conducted comprehensive code review (CODE-REVIEW.md) identifying 26 refactoring opportunities. Implemented Phase 1 (quick wins) and Phase 2 (extract shared libs):

Phase 1:
1. Extracted `withRetry`/`startHeartbeat` to shared `crux/lib/resilience.ts`
2. Created `TOP_LEVEL_CONTENT_DIRS` constant, fixing frontmatter-scanner.mjs bug
3. Added YAML parse error handling in build-data.mjs
4. Added error state + fallback in CauseEffectGraph layout failures
5. Replaced `any` types with proper types in remark-callouts.ts and data/index.ts

Phase 2:
1. Unified metrics-extractor: backported format-aware scoring (table/diagram/index/article) to TS version, switched build-data.mjs to use tsx + import from crux/lib/metrics-extractor.ts, eliminating the 370-line .mjs duplicate
2. Added `formatTime` + `createPhaseLogger` to crux/lib/output.ts, replaced local log() functions in page-creator.ts and page-improver.ts
3. Created shared `CreatorContext` type in crux/authoring/creator/types.ts, replacing 12+ near-identical per-module context interfaces
4. Made crux.mjs use the shared `parseCliArgs` from cli.ts instead of its own weaker implementation
5. Extracted entity-type-mappings.mjs as single source of truth, updated entity-transform.mjs to import from it

**Issues encountered:**
- Pre-existing numericId conflicts in build-data (E698-E708) not related to our changes
- validate-entities.test.ts fails without database.json (pre-existing)

**Learnings/notes:**
- Build scripts now use `node --import tsx/esm` to enable TS imports from crux/
- metrics-extractor.mjs can now be deleted in a follow-up cleanup
- 6 files still exceed 700 lines — Phase 3 restructuring target
