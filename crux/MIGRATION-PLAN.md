# Crux Library Migration Plan

**Goal**: Transform Crux from a collection of ~120 standalone scripts into a typed, composable TypeScript library with a thin CLI layer.

**Current state**: 120 `.mjs` files, 2 `.ts` files, 6 test files. The CLI dispatches most commands by spawning child processes. Each script re-parses argv, re-reads files, re-implements colors and error handling. The codebase works but is hard to maintain, test, or compose.

**Target state**: A typed library (`crux/lib/`) exporting composable functions. The CLI is a thin wrapper that parses args once and calls library functions directly. One process, one data load, shared types throughout.

---

## Architecture: Current vs Target

### Current

```
User runs: pnpm crux validate unified --rules=dollar-signs --fix

crux.mjs (process 1)
  → parses args
  → imports commands/validate.mjs
  → calls createScriptHandler()
  → serializes options to CLI args
  → spawn('node', ['validate/validate-unified.mjs', '--rules=dollar-signs', '--fix'])

validate-unified.mjs (process 2)
  → re-parses process.argv
  → re-creates color helpers
  → re-loads all MDX files from disk
  → creates ValidationEngine
  → runs rules
  → formats output to stdout
  → exits with code
```

Two processes. Data loaded twice. Options serialized to strings and back. No shared types between the dispatcher and the script.

### Target

```
User runs: pnpm crux validate unified --rules=dollar-signs --fix

crux.mjs (single process)
  → parses args
  → imports commands/validate.ts
  → calls validate.unified({rules: ['dollar-signs'], fix: true})
    → calls lib/validation.ts → engine.validate()
    → calls engine.applyFixes()
    → returns typed {issues, summary, filesFixed}
  → formats output
  → exits
```

One process. Data loaded once. Typed options flowing through the whole stack. Library functions are independently importable and testable.

### What the library API looks like

```typescript
// Anyone can import and use these — no CLI required
import { validateFiles, fixIssues } from 'crux/lib/validation';
import { improvePage, createPage, gradePage } from 'crux/lib/authoring';
import { loadEntities, loadPages } from 'crux/lib/data';
import { analyzeLinks, analyzeEntityLinks } from 'crux/lib/analysis';

// Compose operations
const pages = loadPages();
const issues = await validateFiles({ rules: ['dollar-signs'] });
const fixed = fixIssues(issues);
```

---

## What already works well

Before planning changes, it's worth noting what's already good:

1. **`lib/validation-engine.ts`** (523 lines) — Full TypeScript. Clean `Rule` interface, `ContentFile` class, `Issue` class, declarative fix system. This is the migration target pattern.

2. **`lib/content-types.ts`** (304 lines) — Typed data loaders (`loadEntities()`, `loadPages()`), interfaces for `Entity`, `PageEntry`, path constants. Already the right shape.

3. **`commands/insights.mjs` and `commands/gaps.mjs`** — These use Pattern B (direct handlers). They import library functions, call them in-process, format output. No subprocess overhead. This is the target for all commands.

4. **`authoring/creator/`** — Well-decomposed sub-modules with a clean `index.mjs` barrel export. Functions compose naturally: research → synthesis → verification → validation → grading → deployment.

5. **Test coverage** — `cli.test.mjs` (767 lines), `validators.test.mjs` (499 lines), `rules.test.mjs` (415 lines), `metrics-extractor.test.mjs`. Good foundation to catch regressions.

---

## Import path convention

The codebase uses `tsx` (via the shebang `#!/usr/bin/env -S node --import tsx/esm --no-warnings` in `crux.mjs`) to run TypeScript. Existing `.mjs` files import from `.ts` files using either the `.ts` extension directly or the `.js` extension (which `tsx` resolves to `.ts`).

When renaming a file from `.mjs` to `.ts`, **every file that imports it must update its import path**. Before converting any file, grep for all import references to it. This is mechanical but easy to miss — track it per batch.

---

## Phase 0: Foundation (Prerequisites)

**Size**: Small-Medium
**Risk**: Very low — no behavior changes

These are mechanical cleanups that reduce noise and establish the test safety net before the real migration.

### 0a. Fix rules/index.mjs triple-listing

Every rule name appears three times in this file — once in the import, once in the named re-export, and once in the `allRules` array:

```javascript
// Before (137 lines, 3 listings per rule)
import { dollarSignsRule } from './dollar-signs.mjs';
// ... 33 more imports
export { dollarSignsRule, /* ... */ };
export const allRules = [dollarSignsRule, /* ... */];
```

```javascript
// After (~75 lines)
import { dollarSignsRule } from './dollar-signs.mjs';
// ... 33 more imports
export { dollarSignsRule, markdownListsRule, /* ... */ };
export const allRules = [dollarSignsRule, markdownListsRule, /* ... */];
```

### 0b. Standardize data loading

~16 scripts do raw `JSON.parse(readFileSync(...))` instead of using the typed loaders in `content-types.ts`. Find and replace all instances:

```javascript
// Before (scattered across ~16 scripts)
const pages = JSON.parse(readFileSync('app/src/data/pages.json', 'utf-8'));

// After
import { loadPages } from '../lib/content-types.ts';
const pages = loadPages();
```

Known scripts to update (reading `pages.json`, `database.json`, `pathRegistry.json`, or `entities.json`):

- `validate/`: `validate-quality.mjs`, `validate-cross-links.mjs`, `validate-entity-links.mjs`, `validate-component-refs.mjs`
- `lib/rules/`: `component-refs.mjs`, `entity-mentions.mjs`, `fact-consistency.mjs`
- `lib/`: `search.mjs`
- `authoring/`: `regrade.mjs`, `page-improver.mjs`, `creator/duplicate-detection.mjs`

### 0c. Convert test files to TypeScript

The 6 test files should be converted **before** the main migration begins, not after. Tests are the safety net for every subsequent phase — if a `.mjs` → `.ts` rename breaks an import path, the tests should catch it. Converting tests first ensures the safety net itself is solid before relying on it.

| File | Lines |
|------|-------|
| `lib/cli.test.mjs` | 767 |
| `lib/validators.test.mjs` | 499 |
| `lib/rules/rules.test.mjs` | 415 |
| `lib/metrics-extractor.test.mjs` | — |
| `lib/lib.test.mjs` | — |
| `authoring/creator/creator.test.mjs` | — |

These use a custom TAP-like test runner (hand-rolled `test(name, fn)` with try/catch), not vitest. Converting to `.ts` is still low-risk since `tsx` handles the execution. The conversion is mechanical: rename, add type annotations to test data and assertions.

---

## Phase 1: Convert validation rules to TypeScript

**Size**: Medium
**Risk**: Low — each rule is independent, tests catch regressions
**Value**: High — 34 files get type safety, rules become self-documenting

The 34 validation rules in `lib/rules/` are the lowest-hanging fruit. Each is a small, self-contained file (50–200 lines) that already conforms to the `Rule` interface from `validation-engine.ts`. The conversion is mostly mechanical.

### What changes per rule file

```javascript
// Before: lib/rules/dollar-signs.mjs
import { createRule } from '../validation-engine.ts';

export const dollarSignsRule = createRule({
  id: 'dollar-signs',
  name: 'Dollar Signs',
  description: 'Unescaped dollar signs',
  scope: 'file',
  check(file, engine) {
    const issues = [];
    // ... logic
    return issues;
  },
});
```

```typescript
// After: lib/rules/dollar-signs.ts
import { createRule, type ContentFile, type ValidationEngine, type Issue } from '../validation-engine.ts';

export const dollarSignsRule = createRule({
  id: 'dollar-signs',
  name: 'Dollar Signs',
  description: 'Unescaped dollar signs',
  scope: 'file',
  check(file: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    // ... logic (unchanged)
    return issues;
  },
});
```

### Per-batch checklist

For each batch:
1. Rename `.mjs` → `.ts`, add type annotations
2. Update all import paths referencing the renamed files (grep for the old filename)
3. Run `pnpm crux validate` to verify identical output
4. Run `tsc --noEmit -p crux/tsconfig.json` to verify types

After all batches: convert `rules/index.mjs` → `rules/index.ts` and update its importers.

### Batch order (by complexity)

**Batch 1** (simplest):
- `dollar-signs`, `comparison-operators`, `tilde-dollar`, `placeholders`, `fake-urls`, `jsx-in-md`

**Batch 2** (moderate):
- `markdown-lists`, `consecutive-bold-labels`, `editorial-artifacts`, `tone-markers`, `prescriptive-language`, `false-certainty`, `vague-citations`

**Batch 3** (frontmatter/structure):
- `frontmatter-schema`, `estimate-boxes`, `structural-quality`, `quality-source`, `cruft-files`, `sidebar-index`, `sidebar-coverage`

**Batch 4** (entity/link logic):
- `entitylink-ids`, `internal-links`, `external-links`, `citation-urls`, `component-refs`, `component-props`, `component-imports`, `prefer-entitylink`

**Batch 5** (complex, multi-file):
- `entity-mentions` (441 lines), `fact-consistency`, `squiggle-quality`, `temporal-artifacts`, `insider-jargon`, `outdated-names`

---

## Phase 2: Convert remaining lib/ files to TypeScript

**Size**: Medium-Large
**Risk**: Low-Medium — functions don't change, just get typed
**Value**: High — the shared library becomes the typed backbone

### Priority order

| File | Lines | Value | Notes |
|------|-------|-------|-------|
| `lib/mdx-utils.mjs` | 391 | High | Return types prevent frontmatter bugs. `parseFrontmatter`, `extractLinks`, `isInCodeBlock` are used everywhere. |
| `lib/output.mjs` | 137 | Medium | Quick win. `createLogger`, `getColors`, `formatPath`. |
| `lib/file-utils.mjs` | 103 | Medium | Quick win. `findMdxFiles`, `walkDirectory`. |
| `lib/sidebar-utils.mjs` | 57 | Medium | Quick win. Small file, used by sidebar validators. |
| `lib/search.mjs` | 89 | Medium | Quick win. Small file. |
| `lib/metrics-extractor.mjs` | 266 | Medium | `extractMetrics` return type is complex but valuable. |
| `lib/cli.mjs` | 176 | Medium | `createScriptHandler`, `buildCommands` — types help command authors. |
| `lib/redundancy.mjs` | 216 | Medium | Used by `validate-redundancy.mjs` and referenced in Phase 3. |
| `lib/insights.mjs` | 587 | Medium | Complex data structures benefit from types. |
| `lib/anthropic.mjs` | 253 | Medium | API client types, model definitions. |
| `lib/openrouter.mjs` | 313 | Medium | Alternative AI provider client, same pattern as anthropic. |
| `lib/page-templates.mjs` | ~200 | Medium | Template definitions used by grading. |
| `lib/knowledge-db.mjs` | 706 | Low | SQLite wrapper. Needs `@types/better-sqlite3`. Only used by research pipeline. |

### tsconfig.json update

The current `crux/tsconfig.json` only includes `lib/**/*.ts`. This is sufficient for Phases 1–2, but **must be expanded before Phase 3** to cover newly converted directories. See the verification section for details.

### What this unlocks

After Phase 2, the entire `lib/` directory is TypeScript (13 non-test files + 34 rules + 2 already-TS files = 49 typed modules). Any script importing from `lib/` gets full type checking, autocomplete, and refactoring support. This is the foundation for Phases 3–5.

---

## Phase 3: Eliminate subprocess pattern for validators

**Size**: Large
**Risk**: Medium — changes execution model, but validators are well-tested
**Value**: Very high — eliminates the biggest architectural problem

This is the core of the migration. The 23 standalone scripts in `validate/` are the biggest source of boilerplate and the clearest case for the subprocess-to-library conversion.

### The problem in detail

Each validator in `validate/` is an independent script (~100–700 lines) that:
1. Parses its own `process.argv` (~10 lines of boilerplate)
2. Creates its own color helpers (~10 lines)
3. Loads data from disk (~10–20 lines)
4. Runs validation logic (~50–500 lines of actual value)
5. Formats output (~20–50 lines)
6. Exits with a code

Steps 1–3 and 5–6 are duplicated across all 23 scripts. Only step 4 differs.

### tsconfig.json update

Before starting Phase 3, expand `crux/tsconfig.json` `include` to cover the new directories:

```json
"include": ["lib/**/*.ts", "validate/**/*.ts", "commands/**/*.ts"]
```

This ensures `tsc --noEmit` actually checks the converted files. Without this, type errors in `validate/` would be silently ignored.

### The migration pattern

For each standalone validator, extract the core logic into a library function and convert the script to a thin CLI wrapper (or eliminate it entirely if the logic can become a unified rule).

#### Category A: Convert to unified rules

Some standalone validators do simple pattern matching that's already handled by the unified engine pattern. These can become rules in `lib/rules/`:

| Script | Lines | Target |
|--------|-------|--------|
| `validate-sidebar-labels.mjs` | ~100 | New `sidebar-labels` rule |
| `validate-orphaned-files.mjs` | ~120 | Already a `cruft-files` rule — may be redundant |
| `validate-mdx-syntax.mjs` | ~150 | New `mdx-syntax` rule or extend existing rules |
| `validate-consistency.mjs` | ~200 | Already a `fact-consistency` rule — may be redundant |
| `validate-types.mjs` | 122 | New `entity-types` rule or merge into existing type checks |
| `validate-sidebar.mjs` | 147 | Merge with `sidebar-labels` or new `sidebar-structure` rule |

#### Category B: Extract logic into lib/ functions

Validators with complex logic that doesn't fit the per-file rule model:

| Script | Lines | Target lib function |
|--------|-------|---------------------|
| `validate-quality.mjs` | ~150 | `lib/quality.ts` → `checkQualityRatings(pages)` |
| `validate-data.mjs` | ~180 | `lib/data-validation.ts` → `validateEntityData()` |
| `validate-internal-links.mjs` | 304 | `lib/link-validation.ts` → `validateInternalLinks(files)` |
| `validate-cross-links.mjs` | ~200 | `lib/link-validation.ts` → `validateCrossLinks(files)` |
| `validate-entity-links.mjs` | ~250 | `lib/link-validation.ts` → `validateEntityLinks(files)` |
| `validate-component-refs.mjs` | 300 | `lib/link-validation.ts` → `validateComponentRefs(files)` |
| `validate-mermaid.mjs` | 728 | `lib/mermaid-validation.ts` → `validateMermaidDiagrams(files)` |
| `validate-redundancy.mjs` | 484 | `lib/redundancy.ts` (already exists, extend) |
| `validate-style-guide.mjs` | 497 | `lib/style-validation.ts` → `validateStyleGuide(files)` |
| `validate-insights.mjs` | ~150 | Already uses `lib/insights.mjs` — thin wrapper |
| `validate-financials.mjs` | ~100 | `lib/data-validation.ts` → `validateFinancials()` |
| `validate-graph-sync.mjs` | 98 | `lib/data-validation.ts` → `validateGraphSync()` |
| `validate-yaml-schema.mjs` | 178 | `lib/data-validation.ts` → `validateYamlSchema()` |
| `check-staleness.mjs` | 310 | `lib/staleness.ts` → `checkStaleness(pages)` |
| `validate-unified.mjs` | 163 | Becomes the in-process unified runner (core of new `commands/validate.ts`) |

#### Category C: Keep as scripts (subprocess is fine)

Some validators genuinely benefit from process isolation:

| Script | Reason |
|--------|--------|
| `validate-mdx-compile.mjs` | Compiles MDX — memory-intensive, benefits from isolation |
| `validate-all.mjs` | Orchestrator — needs to survive individual validator crashes |

### The new validate command

After migration, `commands/validate.mjs` switches from Pattern A (subprocess) to Pattern B (direct):

```typescript
// commands/validate.ts (target)
import { ValidationEngine } from '../lib/validation-engine.ts';
import { allRules } from '../lib/rules/index.ts';
import { checkQualityRatings } from '../lib/quality.ts';
import { validateEntityData } from '../lib/data-validation.ts';
import { validateInternalLinks } from '../lib/link-validation.ts';
// etc.

export async function unified(args: string[], options: ValidateOptions) {
  const engine = new ValidationEngine();
  await engine.load();
  engine.addRules(allRules);

  const issues = await engine.validate({
    ruleIds: options.rules?.split(','),
  });

  if (options.fix) {
    engine.applyFixes(issues);
  }

  return formatResult(issues, options);
}

export async function quality(args: string[], options: ValidateOptions) {
  const pages = loadPages();
  const result = checkQualityRatings(pages, options);
  return formatResult(result, options);
}

export async function data(args: string[], options: ValidateOptions) {
  const result = validateEntityData(options);
  return formatResult(result, options);
}

// etc.
```

### Migration strategy for validate-all.mjs

`validate-all.mjs` currently orchestrates both unified rules and subprocess validators. After Phase 3:

```typescript
// validate-all.ts (target)
export async function runAll(options: ValidateOptions) {
  const results = [];

  // 1. Unified rules (single-pass, already in-process)
  const engine = new ValidationEngine();
  await engine.load();
  engine.addRules(allRules);
  results.push(await engine.validate());

  // 2. Extracted validators (now in-process too)
  results.push(await validateEntityData());
  results.push(await validateInternalLinks(engine.content));
  results.push(await checkQualityRatings(loadPages()));
  // etc.

  // 3. Subprocess validators (only MDX compile)
  results.push(await runScript('validate/validate-mdx-compile.mjs'));

  return combineResults(results);
}
```

The key insight: extracted validators can share the `engine.content` map (already loaded MDX files), eliminating redundant disk reads.

---

## Phase 4: Convert analysis, fix, and generate scripts

**Size**: Medium-Large
**Risk**: Medium
**Value**: Medium — completes the pattern for non-content domains

Same pattern as Phase 3 but for `analyze/`, `fix/`, and `generate/` scripts, plus root-level scripts.

### tsconfig.json update

Expand includes for newly converted directories:

```json
"include": ["lib/**/*.ts", "validate/**/*.ts", "commands/**/*.ts", "analyze/**/*.ts", "fix/**/*.ts", "generate/**/*.ts", "*.ts"]
```

### Analysis scripts (3 files)

| Script | Lines | Target |
|--------|-------|--------|
| `analyze-all.mjs` | ~200 | `lib/analysis.ts` → `runFullAnalysis()` |
| `analyze-link-coverage.mjs` | ~300 | `lib/analysis.ts` → `analyzeLinkCoverage()` |
| `analyze-entity-links.mjs` | ~270 | `lib/analysis.ts` → `analyzeEntityLinks(id)` |

### Fix scripts (4 files — 2 in `fix/`, 2 at crux root)

| Script | Location | Lines | Target |
|--------|----------|-------|--------|
| `fix/fix-cross-links.mjs` | `fix/` | 610 | `lib/fixes.ts` → `fixCrossLinks(options)` |
| `fix/fix-component-imports.mjs` | `fix/` | ~270 | `lib/fixes.ts` → `fixComponentImports(options)` |
| `fix-broken-links.mjs` | crux root | 490 | `lib/fixes.ts` → `fixBrokenLinks(options)` (relocate to `fix/` during migration) |
| `auto-fix.mjs` | crux root | 98 | Inline into `commands/fix.ts` |

### Generate scripts (6 files — entirely missing from the original plan)

The `generate/` directory contains 6 scripts for producing diagrams, reports, and derived data:

| Script | Lines | Target |
|--------|-------|--------|
| `generate-schema-diagrams.mjs` | 437 | `lib/generation.ts` → `generateSchemaDiagrams()` |
| `generate-summaries.mjs` | 394 | `lib/generation.ts` → `generateSummaries()` |
| `generate-data-diagrams.mjs` | 282 | `lib/generation.ts` → `generateDataDiagrams()` |
| `generate-research-reports.mjs` | 281 | `lib/generation.ts` → `generateResearchReports()` |
| `generate-yaml.mjs` | 273 | `lib/generation.ts` → `generateYaml()` |
| `generate-schema-docs.mjs` | 231 | `lib/generation.ts` → `generateSchemaDocs()` |

### Other root-level scripts

| Script | Lines | Target |
|--------|-------|--------|
| `scan-content.mjs` | 336 | `lib/analysis.ts` → `scanContent()` or keep as standalone |

### Command handlers

Convert subprocess-dispatching command handlers to Pattern B (direct):

| Command handler | Lines | Notes |
|-----------------|-------|-------|
| `commands/analyze.mjs` | — | Convert to direct calls into `lib/analysis.ts` |
| `commands/fix.mjs` | — | Convert to direct calls into `lib/fixes.ts` |
| `commands/generate.mjs` | 82 | Convert to direct calls into `lib/generation.ts` |
| `commands/updates.mjs` | 428 | Already partially Pattern B (`list`/`stats` are direct); convert `run` subcommand |

```typescript
// commands/analyze.ts (target)
import { runFullAnalysis, analyzeLinkCoverage, analyzeEntityLinks } from '../lib/analysis.ts';

export async function all(args, options) {
  return formatResult(await runFullAnalysis(options), options);
}

export async function links(args, options) {
  return formatResult(await analyzeLinkCoverage(options), options);
}
```

---

## Phase 5: Refactor authoring scripts

**Size**: Large
**Risk**: Higher — these are large, AI-heavy scripts
**Value**: Medium — biggest scripts but complexity is in prompts, not structure

The authoring scripts are the largest files in the codebase.

### tsconfig.json update

Expand includes:

```json
"include": ["**/*.ts"]
```

At this point everything is TypeScript, so a broad include is appropriate. Exclude test files if desired:

```json
"exclude": ["**/*.test.ts"]
```

### Strategy: Extract, don't rewrite

These scripts are working, tested, and their complexity is primarily in prompt engineering. Full rewrites would be wasteful. Instead:

1. **Extract the reusable parts** into typed library functions
2. **Keep the orchestration** in the scripts (they're complex pipelines)
3. **Type the interfaces** between orchestration and library

### Core authoring scripts

| Script | Lines | Complexity |
|--------|-------|------------|
| `resource-manager.mjs` | 1945 | SQLite + 10 subcommands |
| `grade-content.mjs` | 960 | 3-step AI grading pipeline |
| `page-improver.mjs` | 935 | Multi-phase AI improvement |
| `page-creator.mjs` | 534 | Already well-decomposed via `creator/` |

### Additional authoring scripts

These were missing from the original plan and need migration too:

| Script | Lines | Strategy |
|--------|-------|----------|
| `reassign-update-frequency.mjs` | 499 | Extract frequency logic → `lib/update-frequency.ts` |
| `grade-by-template.mjs` | 302 | Thin wrapper around grading pipeline — convert to `.ts` |
| `bootstrap-update-frequency.mjs` | 221 | Extract frequency logic → `lib/update-frequency.ts` |
| `regrade.mjs` | 139 | Thin wrapper — convert to `.ts`, uses `loadPages()` |
| `post-improve.mjs` | 133 | Post-processing pipeline — convert to `.ts` |

### Creator sub-modules (10 files)

The `creator/` sub-modules are already well-decomposed. The migration is:
1. Convert `creator/*.mjs` → `creator/*.ts` (add types to function signatures)
2. Convert `page-creator.mjs` → `page-creator.ts` (orchestration stays)

### page-creator.mjs (already good)

### grade-content.mjs (960 lines)

The 3-step pipeline maps to 3 library functions:

```typescript
// lib/grading.ts (new)
export async function runAutomatedWarnings(page: Page): Promise<Warning[]>;
export async function runChecklist(page: Page, client: Anthropic): Promise<ChecklistResult>;
export async function runRatingScales(page: Page, client: Anthropic, context: GradingContext): Promise<Ratings>;
export async function gradeContent(page: Page, options: GradeOptions): Promise<GradeResult>;
```

`grade-content.mjs` becomes a CLI wrapper calling `gradeContent()`.

### page-improver.mjs (935 lines)

Extract the phase system:

```typescript
// lib/improvement.ts (new)
export interface ImprovementPhase { name: string; run(ctx: Context): Promise<void>; }
export async function improvePage(pageId: string, options: ImproveOptions): Promise<ImproveResult>;
```

### resource-manager.mjs (1945 lines)

This is essentially its own mini-application with 10 subcommands. Splitting approach:
1. Extract database operations → already in `lib/knowledge-db.mjs`
2. Extract resource processing → `lib/resources.ts`
3. Keep CLI parsing in script

This one can wait until later — it works fine and isn't blocking other work.

---

## Phase 6: Package structure and exports

**Size**: Small
**Risk**: Low
**Value**: Medium — enables external consumption, cleaner imports

After Phases 1–5, the `crux/` directory has a clean library layer. This phase adds the package interface.

### Add crux/index.ts

```typescript
// crux/index.ts — Public API
export { ValidationEngine, createRule, ContentFile, Issue } from './lib/validation-engine.ts';
export { allRules } from './lib/rules/index.ts';
export { loadEntities, loadPages, loadBacklinks, type Entity, type PageEntry } from './lib/content-types.ts';
export { parseFrontmatter, extractLinks, updateFrontmatter } from './lib/mdx-utils.ts';
export { findMdxFiles, walkDirectory } from './lib/file-utils.ts';
export { extractMetrics } from './lib/metrics-extractor.ts';
export { callClaude, createClient, MODELS } from './lib/anthropic.ts';
// etc.
```

### Add crux/package.json (optional)

If Crux should be independently installable or used as a workspace package:

```json
{
  "name": "@longterm-wiki/crux",
  "type": "module",
  "exports": {
    ".": "./index.ts",
    "./validation": "./lib/validation-engine.ts",
    "./rules": "./lib/rules/index.ts",
    "./data": "./lib/content-types.ts"
  }
}
```

**Note**: If adding `crux/package.json`, also add `"crux"` to `pnpm-workspace.yaml` (which currently only lists `"app"`). Otherwise pnpm won't recognize it as a workspace package.

This is optional — the main value is having clean barrel exports for internal use.

---

## Migration order and dependencies

```
Phase 0: Foundation
  ├─ 0a: Fix rules/index.mjs triple-listing
  ├─ 0b: Standardize data loading
  └─ 0c: Convert test files to TypeScript
         │
Phase 1: Rules → TypeScript (depends on 0a)
         │
Phase 2: lib/ → TypeScript (can run in parallel with Phase 1)
         │
         ├─ Phase 3: Validators → library functions (depends on 1 + 2)
         ├─ Phase 4: Analysis + Fix + Generate → library functions (depends on 2)
         └─ Phase 5: Authoring scripts refactor (depends on 2)
                │
Phase 6: Package structure (depends on 3 + 4 + 5)
```

Phases 1 and 2 can run in parallel. Phases 3, 4, and 5 can run in parallel after Phase 2 completes (Phase 3 also needs Phase 1). Phase 4 has no dependency on Phase 1 or 3, so it can start as soon as Phase 2 is done.

### Each phase = one PR

Keep each phase (or sub-phase for large ones) as a single PR. This gives a clean revert path if something goes wrong mid-migration, and makes review manageable. For large phases (3, 4, 5), consider splitting into sub-PRs by category (e.g., Phase 3A for Category A rules, 3B for Category B extractions).

---

## Effort summary

| Phase | Size | Risk | Value |
|-------|------|------|-------|
| 0: Foundation | S-M | Very low | Enables everything, establishes test safety net |
| 1: Rules → TS | M | Low | 34 typed rules |
| 2: lib/ → TS | M-L | Low | Typed backbone (13 files) |
| 3: Validators → lib | L | Medium | Eliminates subprocess pattern (23 scripts) |
| 4: Analysis + Fix + Generate | L | Medium | Completes pattern (14 scripts + 4 command handlers) |
| 5: Authoring refactor | L | Higher | Typed AI pipelines (9 scripts + 10 creator modules) |
| 6: Package structure | S | Low | Clean exports |

### Recommended stopping points

If you want to do only part of this:

**Minimal (Phases 0–1)**: Gets 34 typed rules, clean data loading. The rules are the most-touched files and benefit most from types. Good ROI.

**Solid (Phases 0–2)**: Entire `lib/` is TypeScript. Every script that imports from lib gets type safety. Major quality improvement.

**Full library (Phases 0–4)**: Subprocess pattern eliminated for validators, analysis, fixes, and generation. Only authoring scripts still run as subprocesses (which is acceptable — they're long-running AI pipelines).

**Complete (all phases)**: Everything typed and composable. This is the "proper package" endgame.

---

## Verification at each phase

Each phase should pass these checks before moving to the next:

```bash
# Type checking (IMPORTANT: only meaningful if tsconfig.json includes the right dirs)
tsc --noEmit -p crux/tsconfig.json

# Functional verification
pnpm crux --help                              # CLI loads
pnpm crux validate                            # Full validation suite
pnpm crux validate unified --rules=dollar-signs --fix  # Specific rule with fix
pnpm test                                     # App tests pass

# No regressions
# Run validate before and after, diff the output
pnpm crux validate 2>&1 | tee /tmp/before.txt
# ... make changes ...
pnpm crux validate 2>&1 | tee /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

### tsconfig.json include progression

The `include` field in `crux/tsconfig.json` must be expanded as new directories gain `.ts` files. If it isn't, `tsc --noEmit` will silently pass even with type errors in unconverted directories — giving false confidence.

| After Phase | `include` should be |
|-------------|---------------------|
| 0–2 | `["lib/**/*.ts"]` (current, sufficient) |
| 3 | `["lib/**/*.ts", "validate/**/*.ts", "commands/**/*.ts"]` |
| 4 | Add `"analyze/**/*.ts"`, `"fix/**/*.ts"`, `"generate/**/*.ts"`, `"*.ts"` |
| 5 | `["**/*.ts"]` (everything is now TypeScript) |

---

## File coverage verification

Rather than maintaining a static inventory that goes stale whenever scripts are added or removed, use this check to find any `.mjs` files not yet covered by the migration:

```bash
# List all .mjs files not yet converted to .ts
find crux/ -name '*.mjs' -not -name '*.test.mjs' -not -name 'crux.mjs' | sort
```

At the start of migration this returns 113 files (120 total minus 6 test files minus `crux.mjs`). After each phase, this count should drop. When it reaches 0, the migration is complete.

### Phase-to-directory mapping

| Phase | Directories / files covered |
|-------|---------------------------|
| 0 | `**/*.test.mjs` (6 test files) |
| 1 | `lib/rules/*.mjs` (34 rules + `index.mjs`) |
| 2 | `lib/*.mjs` (13 non-test, non-rules files) |
| 3 | `validate/*.mjs` (23 scripts) + `commands/validate.mjs` |
| 4 | `analyze/*.mjs` (3), `fix/*.mjs` (2), `generate/*.mjs` (6), root scripts (`fix-broken-links.mjs`, `auto-fix.mjs`, `scan-content.mjs`), `commands/{analyze,fix,generate,updates,insights,gaps}.mjs` |
| 5 | `authoring/*.mjs` (9), `authoring/creator/*.mjs` (10), `commands/{content,resources}.mjs` |

`crux.mjs` stays as-is (see "What NOT to change").

**Total: 120 `.mjs` files accounted for** (113 migrated + 6 tests converted + 1 kept).

---

## What NOT to change

1. **`crux.mjs` filename and extension** — Entry point, shebang-based. Changing to `.ts` or renaming to `cli.mjs`/`index.mjs` is unnecessary churn.

2. **CLI domain names** — `validate`, `content`, `analyze`, etc. are user-facing API. Don't rename.

3. **MDX compilation isolation** — `validate-mdx-compile.mjs` should stay as a subprocess. MDX compilation is memory-intensive and can crash; process isolation is correct here.

4. **Authoring script entry points** — `page-creator.mjs`, `page-improver.mjs`, `grade-content.mjs` are invoked directly by Claude Code via `.claude/settings.local.json` permissions. The filenames are part of the external interface. Keep them as CLI entry points that call into library functions. When renaming to `.ts`, update `.claude/settings.local.json` paths in the same commit.

5. **Resource manager** — At 1945 lines, this is effectively its own mini-app. It works. Refactoring it has low ROI relative to effort. Leave it for last or skip it.

6. **Test framework** — vitest works. Don't change it.

7. **Runtime mechanism** — `tsx` handles TypeScript execution. Don't introduce a build step (tsc compilation, bundling). The value of this migration is types and structure, not a different runtime.
