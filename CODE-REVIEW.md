# Code Review: Refactoring Opportunities

**Date:** 2026-02-16
**Scope:** Full codebase — app/, crux/, build scripts, data layer, tests
**Methodology:** Deep automated review of all source files, cross-referencing for duplication, pattern inconsistencies, and architectural issues.

---

## Executive Summary

The codebase is well-structured overall, with clear separation between the Next.js app, CLI tooling (crux), and data layer. However, organic growth has introduced **duplicated utilities**, **oversized files**, and **inconsistent patterns** that create maintenance burden. The highest-ROI refactorings fall into three categories:

1. **Extract shared utilities** — `withRetry`, metrics-extractor, directory lists, and color constants are duplicated across boundaries
2. **Break up large files** — 6 files exceed 700 lines and mix multiple concerns
3. **Standardize patterns** — argument parsing, error handling, test setup, and component structure vary across similar modules

---

## Critical Priority (Fix First)

### 1. Duplicated `withRetry` / `startHeartbeat` across crux authoring modules

**Files:**
- `crux/authoring/page-improver.ts:112-135`
- `crux/authoring/creator/api-direct.ts:26-49`

**Problem:** Identical 24-line `withRetry` function (exponential backoff with retryable error detection) is copy-pasted between files. `startHeartbeat` is similarly duplicated.

**Fix:** Extract to `crux/lib/resilience.ts`:
```ts
export async function withRetry<T>(fn, opts): Promise<T> { ... }
export function startHeartbeat(phase, intervalSec): () => void { ... }
```

**Savings:** ~60 lines, eliminates divergence risk for critical infrastructure code.

---

### 2. Duplicate metrics-extractor implementations

**Files:**
- `app/scripts/lib/metrics-extractor.mjs` (372 lines, plain JS)
- `crux/lib/metrics-extractor.ts` (287 lines, TypeScript)

**Problem:** Two parallel implementations of the same quality-scoring logic. The `.mjs` version is used by `build-data.mjs`; the `.ts` version is used by crux. They've already diverged — the TS version uses `visual-detection.ts` for enhanced counting while the JS version doesn't.

**Fix:** Make crux's TypeScript version canonical. Either:
- (a) Have build-data import from crux via `tsx`, or
- (b) Add a build step that transpiles the TS version to `.mjs` for consumption by build scripts.

**Savings:** ~370 lines of duplicate logic, ensures scoring parity between build and CLI.

---

### 3. Hardcoded directory arrays duplicated 3 times

**Files:**
- `app/scripts/build-data.mjs:515` — `otherDirs` (10 entries)
- `app/scripts/build-data.mjs:568` — `topLevelDirs` (10 entries, identical)
- `app/scripts/lib/frontmatter-scanner.mjs:77` — only **3 entries** (bug!)

**Problem:** The frontmatter scanner only scans `['ai-transition-model', 'analysis', 'internal']`, while build-data scans 10 directories. Pages in `getting-started`, `guides`, `insight-hunting`, `dashboard`, `project`, `style-guides`, and `browse` won't get auto-entity creation from frontmatter `entityType` declarations.

**Fix:** Define a single `CONTENT_DIRECTORIES` constant in `app/scripts/lib/content-types.mjs` and import it everywhere. Fix frontmatter-scanner to use the full list.

**Savings:** Eliminates a real consistency bug + prevents future directory-list drift.

---

### 4. Build script modifies source files as a side effect

**File:** `app/scripts/build-data.mjs:690-696, 949-962`

**Problem:** `build-data.mjs` writes `numericId` values directly into MDX frontmatter during the build. If the build fails partway through, source files are left in an inconsistent state with some IDs written and others not. This violates separation of concerns — builds should be read-only transforms.

**Fix:** Separate ID assignment from file writes:
1. Collect pending assignments into a manifest (e.g., `data/pending-id-assignments.json`)
2. Create a separate `pnpm crux id-apply` command that performs the writes
3. Or run ID assignment as a pre-build step that completes fully before the main build begins

---

## High Priority (Do Soon)

### 5. CauseEffectGraph component is 708 lines mixing 6+ concerns

**File:** `app/src/components/wiki/CauseEffectGraph/index.tsx`

**Problem:** Single component handles YAML export generation, Mermaid code generation, graph traversal algorithms, node/edge styling (120+ lines of useMemo), tab management, layout orchestration, and 10+ state variables.

**Fix:** Extract into focused modules:
- `graph-algorithms.ts` — traversal, path highlighting
- `graph-export.ts` — YAML and Mermaid generation
- `styled-elements.ts` — `getStyledNodes()` and `getStyledEdges()` utilities
- Split tab views into separate components

---

### 6. TransitionModelTableClient is 792 lines with 3 near-identical column creators

**File:** `app/src/components/wiki/TransitionModelTableClient.tsx`

**Problem:** Contains three `create*Columns` functions (lines 277-555) with ~95% duplicate code, 6+ inline helper components (`ExpandableRow`, `ParamLink`, `RatingCell`, etc.), and mixed state management.

**Fix:**
- Extract a column factory that takes config and produces columns
- Move helper components to a separate file
- Extract expanded-row state into a custom hook

---

### 7. Three crux files exceed 1,000 lines each

| File | Lines | What it does |
|------|-------|-------------|
| `crux/authoring/page-improver.ts` | 1,740 | Multi-phase page improvement pipeline |
| `crux/authoring/grade-content.ts` | 1,109 | 3-step grading pipeline + system prompts |
| `crux/check-links.ts` | 1,073 | URL validation, health checking, categorization |

**Fix:** Each should be split into a directory with 4-5 focused modules of ~250 lines:
- `page-improver/` → `index.ts`, `phases.ts`, `research.ts`, `synthesis.ts`, `validation.ts`
- `grading/` → `index.ts`, `step1-warnings.ts`, `step2-checklist.ts`, `step3-ratings.ts`, `prompts.ts`
- `link-checker/` → `index.ts`, `checker.ts`, `categorizer.ts`, `reporters.ts`

---

### 8. Missing YAML parse error handling in build script

**File:** `app/scripts/build-data.mjs:47-78`

**Problem:** `loadYaml()` and `loadYamlDir()` call `parse(content)` without try-catch. A YAML syntax error crashes the entire build with an unhelpful stack trace and no indication of which file failed.

**Fix:** Wrap in try-catch, log the filename, and either collect errors or fail gracefully:
```js
try {
  return parse(content) || [];
} catch (e) {
  console.error(`Failed to parse YAML: ${filepath}: ${e.message}`);
  return [];
}
```

---

### 9. Layout error silently breaks UI

**File:** `app/src/components/wiki/CauseEffectGraph/index.tsx:348-355`

**Problem:** When the graph layout algorithm fails, the error is `console.error`'d but no error state is set. The UI gets stuck showing "Computing layout..." forever.

**Fix:** Add an `errorState` and display a fallback message when layout fails. Consider falling back to unpositioned nodes.

---

### 10. O(n^2) algorithms in build pipeline

**Files:**
- `app/scripts/build-data.mjs:262-270` — Entity name-prefix matching (O(n^2) string comparisons)
- `app/scripts/lib/redundancy.mjs:131-184` — Page pair redundancy analysis (~195K comparisons for 625 pages)
- `app/scripts/lib/statistics.mjs:49-62` — `entities.find()` in a loop (N+1 pattern)

**Fix:**
- Name-prefix: sort entities and compare adjacent entries (O(n log n))
- Statistics: pre-build a `Map<id, entity>` for O(1) lookup
- Redundancy: consider category-based clustering or incremental caching

---

## Medium Priority (Plan to Do)

### 11. Argument parsing reimplemented in 5+ files

Each crux script/module implements its own arg parsing logic. `crux.mjs` has one approach, `lib/cli.ts` has `parseCliArgs()`, `resource-manager.ts` reimplements it, `validate-unified.ts` has its own.

**Fix:** Create `crux/lib/args.ts` with a unified parser supporting `--key=value`, `--flag`, positional args, and type coercion.

---

### 12. Context/options interfaces proliferate across authoring modules

Nearly identical `{ log, saveResult, getTopicDir, ROOT }` context objects are defined separately in `research.ts`, `synthesis.ts`, `deployment.ts`, and other authoring modules.

**Fix:** Define `PipelinePhase`, `PipelineIO`, `PipelineEnvironment` base types in `crux/lib/context-types.ts`.

---

### 13. Color and style constants duplicated across app components

**Files:**
- `app/src/components/tables/shared/table-view-styles.ts` — 15+ color objects
- `app/src/components/wiki/TransitionModelTableClient.tsx:80-130` — inline color configs
- Multiple table views — category ordering hardcoded inline

**Fix:** Consolidate all color definitions into a single `app/src/lib/theme-constants.ts`. Create a unified badge/color resolver.

---

### 14. Legend and badge components reimplemented 3 times

`AccidentRisksTableView`, `SafetyApproachesTableView`, and `cell-components.tsx` each implement essentially the same badge rendering component with slightly different props.

**Fix:** Create a single `<LegendBadge>` and data-driven `<LegendSection>` component.

---

### 15. Entity type mapping defined in both TS and JS

**Files:**
- `app/src/data/entity-type-names.ts` — canonical TypeScript source
- `app/scripts/lib/entity-transform.mjs:19-43` — manually copied JS version

The comment in `entity-transform.mjs` says "Canonical definition lives in entity-type-names.ts. This .mjs copy exists because build scripts can't import .ts directly."

**Fix:** Either generate the `.mjs` from the `.ts` source as a build step, or use `tsx` to run build scripts with TypeScript support.

---

### 16. Validation rule boilerplate across 43 rule files

Many rules in `crux/lib/rules/` repeat the same pattern: call `matchLinesOutsideCode`, extract context, create `Issue` with the same shape.

**Fix:** Create a `createMatchingRule()` factory in `crux/lib/rules/rule-helpers.ts` that accepts regex patterns and message templates, reducing each simple rule to ~10 lines of config.

---

### 17. Relationship label map is hardcoded and incomplete

**File:** `app/scripts/build-data.mjs:197-229`

The `INVERSE_LABEL` map lives only in build-data and isn't validated against actual YAML relationships. New relationship types silently get no inverse.

**Fix:** Move to a data file (`data/relationship-labels.yaml`), validate at build time that all YAML relationships have entries.

---

## Test Suite Issues

### 18. Large monolithic test files

| File | Lines | Covers |
|------|-------|--------|
| `crux/lib/cli.test.ts` | 808 | Case conversion, duration, options, validation engine |
| `crux/lib/rules/rules.test.ts` | 720 | 14 different validation rules |
| `app/src/data/__tests__/data.test.ts` | 483 | Entire data layer |

**Fix:** Split by concern. `rules.test.ts` → one test file per rule. `cli.test.ts` → separate `validation-engine.test.ts`.

---

### 19. No shared test utilities

Multiple test files reimplement: temp file cleanup, mock content factories, mock database setup, file system mocking. Each uses slightly different approaches.

**Fix:** Create `crux/lib/test-utils/` with:
- `mock-content.ts` — `mockContent(body, overrides)` factory
- `mock-fs.ts` — type-safe file system mock
- `temp-files.ts` — temp directory setup/cleanup

---

### 20. Inconsistent mocking approaches

- `app/src/lib/__tests__/mdx.test.ts` — `vi.mock()` at module level
- `app/src/data/__tests__/data.test.ts` — `vi.mock()` + dynamic `import()`
- `crux/lib/validators.test.ts` — no mocks, loads real files

**Fix:** Document a mocking convention and create standard helpers.

---

### 21. creator.test.ts permanently excluded

`crux/vitest.config.ts` excludes `authoring/creator/creator.test.ts` because it eagerly loads `better-sqlite3` native bindings.

**Fix:** Refactor `knowledge-db.ts` to use lazy initialization so the test can run normally.

---

## Low Priority (Nice to Have)

### 22. Logging reimplemented per-script
Each crux script defines its own `log()` function with slightly different timestamp/format. **Fix:** Enhance `crux/lib/output.ts` with structured logging.

### 23. Command handler boilerplate
All 9 crux command handlers follow the identical `SCRIPTS` → `buildCommands()` pattern. **Fix:** Consider a domain registry or declarative config.

### 24. Missing progress feedback in build
Redundancy analysis and search index building process hundreds of items with no progress output. **Fix:** Add progress callbacks for operations >5s.

### 25. `any` types in app source
7 occurrences across 3 files (`remark-callouts.ts`, `data/index.ts`, `data.test.ts`). Low count but worth cleaning up.

### 26. Missing performance/regression tests
No benchmarks for validating 625+ pages or building the full database. **Fix:** Add optional `*.perf.test.ts` files.

---

## Summary: Refactoring Roadmap

| Phase | Items | Est. Lines Saved | Theme |
|-------|-------|-----------------|-------|
| **Phase 1: Quick wins** | #1, #3, #8, #9, #25 | ~200 | Eliminate bugs & duplication |
| **Phase 2: Extract shared libs** | #2, #11, #12, #15, #22 | ~800 | Single source of truth |
| **Phase 3: Break up large files** | #5, #6, #7 | ~0 (restructure) | Maintainability |
| **Phase 4: Standardize patterns** | #13, #14, #16, #17 | ~400 | Consistency |
| **Phase 5: Test infrastructure** | #18, #19, #20, #21 | ~300 | Test quality |
| **Phase 6: Build pipeline** | #4, #10, #23, #24 | ~100 | Performance & UX |

Total impact: ~1,800 lines of duplication removed, 6 oversized files restructured, 1 real bug fixed (frontmatter scanner directory list), and significantly improved maintainability across the codebase.
