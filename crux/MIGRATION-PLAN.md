# Crux Library Migration Plan

**Goal**: Transform Crux from a collection of ~120 standalone scripts into a typed, composable TypeScript library with a thin CLI layer.

**Current state**: 120 `.mjs` files, 2 `.ts` files. The CLI dispatches commands by spawning child processes. Each script re-parses argv, re-reads files, re-implements colors and error handling. The codebase works but is hard to maintain, test, or compose.

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

## Phase 0: Foundation (Prerequisites)

**Estimated effort**: 2–4 hours
**Risk**: Very low — no behavior changes

These are mechanical cleanups that reduce noise before the real migration.

### 0a. Fix rules/index.mjs double-import

Every rule is imported twice — once for re-export, once for the `allRules` array.

```javascript
// Before (151 lines, 2 imports per rule)
import { dollarSignsRule } from './dollar-signs.mjs';
export { dollarSignsRule };
// ... 33 more
import { dollarSignsRule as _ds } from './dollar-signs.mjs';
export const allRules = [_ds, ...];
```

```javascript
// After (~75 lines)
import { dollarSignsRule } from './dollar-signs.mjs';
// ... 33 more imports
export { dollarSignsRule, markdownListsRule, /* ... */ };
export const allRules = [dollarSignsRule, markdownListsRule, /* ... */];
```

### 0b. Standardize data loading

Many scripts do raw `JSON.parse(readFileSync(...))` instead of using the typed loaders in `content-types.ts`. Find and replace all instances:

```javascript
// Before (scattered across ~15 scripts)
const pages = JSON.parse(readFileSync('app/src/data/pages.json', 'utf-8'));

// After
import { loadPages } from '../lib/content-types.ts';
const pages = loadPages();
```

Scripts to update: `validate-quality.mjs`, `validate-data.mjs`, `validate-internal-links.mjs`, `validate-cross-links.mjs`, `validate-entity-links.mjs`, `analyze-all.mjs`, `analyze-link-coverage.mjs`, and others that load `pages.json`, `entities.json`, or `backlinks.json`.

### 0c. Extract shared arg parsing

Create a simple shared arg parser to replace the ~20 files that manually parse `process.argv`:

```typescript
// lib/args.ts
export interface ParsedArgs {
  positional: string[];
  flags: Record<string, boolean>;
  options: Record<string, string>;
}

export function parseScriptArgs(argv = process.argv.slice(2)): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, boolean> = {};
  const options: Record<string, string> = {};

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (value === undefined) flags[key] = true;
      else options[key] = value;
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags, options };
}
```

This doesn't need to be adopted everywhere immediately — it's available for scripts as they get migrated.

---

## Phase 1: Convert validation rules to TypeScript

**Estimated effort**: 6–8 hours
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

### Approach

1. Convert rules in batches of 5–8, from simplest to most complex
2. After each batch, run `pnpm crux validate` to verify identical output
3. Update `rules/index.mjs` → `rules/index.ts` after all rules are converted

### Batch order (by complexity)

**Batch 1** (simplest, ~30 min each):
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

**Estimated effort**: 8–12 hours
**Risk**: Low-Medium — functions don't change, just get typed
**Value**: High — the shared library becomes the typed backbone

### Priority order

| File | Lines | Effort | Value | Notes |
|------|-------|--------|-------|-------|
| `lib/mdx-utils.mjs` | 391 | 3h | High | Return types prevent frontmatter bugs. Functions like `parseFrontmatter`, `extractLinks`, `isInCodeBlock` are used everywhere. |
| `lib/output.mjs` | 137 | 1h | Medium | Quick win. `createLogger`, `getColors`, `formatPath`. |
| `lib/file-utils.mjs` | 103 | 1h | Medium | Quick win. `findMdxFiles`, `walkDirectory`. |
| `lib/metrics-extractor.mjs` | 266 | 2h | Medium | `extractMetrics` return type is complex but valuable. |
| `lib/cli.mjs` | 176 | 2h | Medium | `createScriptHandler`, `buildCommands` — types help command authors. |
| `lib/insights.mjs` | 587 | 3h | Medium | Complex data structures benefit from types. |
| `lib/anthropic.mjs` | 253 | 2h | Medium | API client types, model definitions. |
| `lib/knowledge-db.mjs` | 706 | 4h | Low | SQLite wrapper. Needs `@types/better-sqlite3`. Lower priority — only used by research pipeline. |
| `lib/page-templates.mjs` | ~200 | 1h | Medium | Template definitions used by grading. |

### What this unlocks

After Phase 2, the entire `lib/` directory is TypeScript. Any script importing from `lib/` gets full type checking, autocomplete, and refactoring support. This is the foundation for Phase 3.

---

## Phase 3: Eliminate subprocess pattern for validators

**Estimated effort**: 12–16 hours
**Risk**: Medium — changes execution model, but validators are well-tested
**Value**: Very high — eliminates the biggest architectural problem

This is the core of the migration. The 23 standalone validators in `validate/` are the biggest source of boilerplate and the clearest case for the subprocess-to-library conversion.

### The problem in detail

Each validator in `validate/` is an independent script (~100–700 lines) that:
1. Parses its own `process.argv` (~10 lines of boilerplate)
2. Creates its own color helpers (~10 lines)
3. Loads data from disk (~10–20 lines)
4. Runs validation logic (~50–500 lines of actual value)
5. Formats output (~20–50 lines)
6. Exits with a code

Steps 1–3 and 5–6 are duplicated across all 23 scripts. Only step 4 differs.

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

#### Category B: Extract logic into lib/ functions

Validators with complex logic that doesn't fit the per-file rule model:

| Script | Lines | Target lib function |
|--------|-------|---------------------|
| `validate-quality.mjs` | ~150 | `lib/quality.ts` → `checkQualityRatings(pages)` |
| `validate-data.mjs` | ~180 | `lib/data-validation.ts` → `validateEntityData()` |
| `validate-internal-links.mjs` | 304 | `lib/link-validation.ts` → `validateInternalLinks(files)` |
| `validate-cross-links.mjs` | ~200 | `lib/link-validation.ts` → `validateCrossLinks(files)` |
| `validate-entity-links.mjs` | ~250 | `lib/link-validation.ts` → `validateEntityLinks(files)` |
| `validate-mermaid.mjs` | 728 | `lib/mermaid-validation.ts` → `validateMermaidDiagrams(files)` |
| `validate-redundancy.mjs` | 484 | `lib/redundancy.ts` (already exists, extend) |
| `validate-style-guide.mjs` | 497 | `lib/style-validation.ts` → `validateStyleGuide(files)` |
| `validate-insights.mjs` | ~150 | Already uses `lib/insights.mjs` — thin wrapper |
| `validate-financial.mjs` | ~100 | `lib/data-validation.ts` → `validateFinancials()` |

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

## Phase 4: Convert analysis and fix scripts

**Estimated effort**: 6–10 hours
**Risk**: Medium
**Value**: Medium — completes the pattern for non-content domains

Same pattern as Phase 3 but for `analyze/` and `fix/` scripts.

### Analysis scripts

| Script | Lines | Target |
|--------|-------|--------|
| `analyze-all.mjs` | ~200 | `lib/analysis.ts` → `runFullAnalysis()` |
| `analyze-link-coverage.mjs` | ~300 | `lib/analysis.ts` → `analyzeLinkCoverage()` |
| `analyze-entity-links.mjs` | ~270 | `lib/analysis.ts` → `analyzeEntityLinks(id)` |

### Fix scripts

| Script | Lines | Target |
|--------|-------|--------|
| `fix-cross-links.mjs` | 610 | `lib/fixes.ts` → `fixCrossLinks(options)` |
| `fix-broken-links.mjs` | 490 | `lib/fixes.ts` → `fixBrokenLinks(options)` |
| `fix-component-imports.mjs` | ~270 | `lib/fixes.ts` → `fixComponentImports(options)` |
| `auto-fix.mjs` | ~50 | Inline into `commands/fix.ts` |

### Command handlers become direct

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

**Estimated effort**: 15–25 hours
**Risk**: Higher — these are large, AI-heavy scripts
**Value**: Medium — biggest scripts but complexity is in prompts, not structure

The authoring scripts are the largest files in the codebase:

| Script | Lines | Complexity |
|--------|-------|------------|
| `resource-manager.mjs` | 1945 | SQLite + 10 subcommands |
| `grade-content.mjs` | 960 | 3-step AI grading pipeline |
| `page-improver.mjs` | 935 | Multi-phase AI improvement |
| `page-creator.mjs` | 534 | Already well-decomposed via `creator/` |

### Strategy: Extract, don't rewrite

These scripts are working, tested, and their complexity is primarily in prompt engineering. Full rewrites would be wasteful. Instead:

1. **Extract the reusable parts** into typed library functions
2. **Keep the orchestration** in the scripts (they're complex pipelines)
3. **Type the interfaces** between orchestration and library

### page-creator.mjs (already good)

The `creator/` sub-modules are already well-decomposed. The migration is:
1. Convert `creator/*.mjs` → `creator/*.ts` (add types to function signatures)
2. Convert `page-creator.mjs` → `page-creator.ts` (orchestration stays)

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

**Estimated effort**: 4–6 hours
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

This is optional — the main value is having clean barrel exports for internal use.

---

## Migration order and dependencies

```
Phase 0: Foundation
  ├─ 0a: Fix rules/index.mjs double-import
  ├─ 0b: Standardize data loading
  └─ 0c: Extract shared arg parsing
         │
Phase 1: Rules → TypeScript (depends on 0a)
         │
Phase 2: lib/ → TypeScript (independent of Phase 1)
         │
Phase 3: Validators → library functions (depends on 1 + 2)
         │
Phase 4: Analysis + Fix → library functions (depends on 2)
         │
Phase 5: Authoring scripts refactor (depends on 2)
         │
Phase 6: Package structure (depends on 3 + 4)
```

Phases 1 and 2 can run in parallel. Phases 3, 4, and 5 can run in parallel after their dependencies are met.

---

## Effort summary

| Phase | Effort | Risk | Value |
|-------|--------|------|-------|
| 0: Foundation | 2–4h | Very low | Enables everything |
| 1: Rules → TS | 6–8h | Low | 34 typed rules |
| 2: lib/ → TS | 8–12h | Low | Typed backbone |
| 3: Validators → lib | 12–16h | Medium | Eliminates subprocess pattern |
| 4: Analysis + Fix → lib | 6–10h | Medium | Completes pattern |
| 5: Authoring refactor | 15–25h | Higher | Typed AI pipelines |
| 6: Package structure | 4–6h | Low | Clean exports |
| **Total** | **53–81h** | | |

### Recommended stopping points

If you want to do only part of this:

**Minimal (Phases 0–1)**: ~10 hours. Gets 34 typed rules, clean data loading. The rules are the most-touched files and benefit most from types. Good ROI.

**Solid (Phases 0–2)**: ~20 hours. Entire `lib/` is TypeScript. Every script that imports from lib gets type safety. Major quality improvement.

**Full library (Phases 0–4)**: ~40 hours. Subprocess pattern eliminated for validators, analysis, and fixes. Only authoring scripts still run as subprocesses (which is acceptable — they're long-running AI pipelines).

**Complete (all phases)**: ~60 hours. Everything typed and composable. This is the "proper package" endgame.

---

## Verification at each phase

Each phase should pass these checks before moving to the next:

```bash
# Type checking
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

---

## What NOT to change

1. **`crux.mjs` filename** — Already discussed. `crux/crux.mjs` is slightly redundant but changing to `cli.mjs` or `index.mjs` is unnecessary churn.

2. **CLI domain names** — `validate`, `content`, `analyze`, etc. are user-facing API. Don't rename.

3. **MDX compilation isolation** — `validate-mdx-compile.mjs` should stay as a subprocess. MDX compilation is memory-intensive and can crash; process isolation is correct here.

4. **Authoring script entry points** — `page-creator.mjs`, `page-improver.mjs`, `grade-content.mjs` are invoked directly by Claude Code via `.claude/settings.local.json` permissions. The filenames are part of the external interface. Keep them as CLI entry points that call into library functions.

5. **Resource manager** — At 1945 lines, this is effectively its own mini-app. It works. Refactoring it has low ROI relative to effort. Leave it for last or skip it.
