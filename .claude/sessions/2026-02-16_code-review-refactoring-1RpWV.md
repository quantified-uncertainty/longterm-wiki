## 2026-02-16 | claude/code-review-refactoring-1RpWV | Code review + Phase 1 refactoring

**What was done:** Conducted comprehensive code review (CODE-REVIEW.md) identifying 26 refactoring opportunities, then implemented Phase 1 quick wins:
1. Extracted `withRetry`/`startHeartbeat` to shared `crux/lib/resilience.ts` module, replacing duplicated code in page-improver.ts and api-direct.ts
2. Created `TOP_LEVEL_CONTENT_DIRS` constant in content-types.mjs, fixing frontmatter-scanner.mjs bug (was scanning 3 of 10 directories) and eliminating duplicate arrays in build-data.mjs
3. Added try-catch error handling to `loadYaml`/`loadYamlDir` in build-data.mjs
4. Added error state + fallback to unpositioned nodes in CauseEffectGraph when layout fails
5. Replaced `any` types with proper types in remark-callouts.ts and data/index.ts

**Issues encountered:**
- Pre-existing numericId conflicts in build-data (E698-E708) prevent full build; not related to our changes
- validate-entities.test.ts fails without database.json (pre-existing)

**Learnings/notes:**
- metrics-extractor has two diverging implementations (.mjs for build, .ts for crux) — Phase 2 target
- Build script writes numericIds to MDX files as a side effect during builds — Phase 2 architectural fix
- 6 files exceed 700 lines and mix multiple concerns — Phase 3 restructuring target
