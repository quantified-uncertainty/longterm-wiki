# Crux Library Migration Plan

**Goal**: Transform Crux from a collection of ~120 standalone scripts into a typed, composable TypeScript library with a thin CLI layer.

**Current state**: 120 `.mjs` files, 2 `.ts` files. The CLI dispatches commands by spawning child processes. Each script re-parses argv, re-reads files, re-implements colors and error handling. The codebase works but is hard to maintain, test, or compose.

**Target state**: A typed library (`crux/lib/`) exporting composable functions. The CLI is a thin wrapper that parses args once and calls library functions directly. One process, one data load, shared types throughout.

---

## Red Team: Risks, Failure Modes, and Alternative Approaches

Before diving into the phased plan, here's an honest critique of the entire migration strategy — what could go wrong, what the plan gets wrong, and what alternatives exist.

### 1. The half-migrated state is the real danger

The plan describes a clean endgame, but the codebase will spend months in a half-migrated state. This is arguably **worse** than either endpoint:

- Some files are `.ts`, some are `.mjs`. Import paths become confusing (do you write `.ts`, `.js`, or no extension?).
- Some commands use Pattern A (subprocess), some use Pattern B (direct). Contributors need to understand both.
- Some scripts use `loadPages()` from content-types.ts, others still do `JSON.parse(readFileSync(...))`. Both patterns coexist.
- The tsconfig `include` pattern has to keep expanding. Type errors in newly-converted files may cascade into unconverted ones.

**Mitigation**: Each phase must be completable in 1–2 sessions and leave the codebase in a consistent state. Never convert half of the validators — convert all or none. The plan's "batch" approach for rules is fine; the phased approach for validators is riskier.

### 2. The effort estimates are probably 2–3x too low

The plan estimates 53–81 hours total. This is almost certainly optimistic:

- **"Mechanical" conversions are never mechanical.** Converting `dollar-signs.mjs` to `.ts` will surface implicit `any` types, untyped regex match results, `null` vs `undefined` mismatches, and edge cases in the `check()` function signature. Each rule may take 30 min on paper but 60–90 min in practice.
- **Phase 3 (validators → library) is underestimated at 12–16h.** Each validator does more than the plan suggests. `validate-mermaid.mjs` is 728 lines of Mermaid parsing logic, not 50 lines of boilerplate + 50 lines of logic. Extracting it into a library function means designing an API, handling error cases, testing the new API, and updating the command handler.
- **Integration testing gaps.** The plan assumes `pnpm crux validate` output can be diffed before/after. But validators produce non-deterministic output (timestamps, file ordering, performance metrics). You'll need snapshot-style tests, not just diff.

**Realistic estimate**: 100–150 hours for the full migration, or 40–60 hours for Phases 0–2 (the "solid" stopping point).

### 3. Who benefits from this migration?

The plan assumes composable library functions are valuable. But who would actually call `improvePage()` programmatically?

- **Claude Code** calls scripts via `node crux/authoring/page-improver.mjs` with CLI args. It doesn't import TypeScript functions. Even after the migration, Claude Code would still invoke the CLI — it wouldn't call library functions directly.
- **CI** runs `pnpm crux validate`. It uses the CLI.
- **Developers** run `pnpm crux content improve <id>`. They use the CLI.
- **No external consumers.** This is an internal tool, not a published npm package. Nobody will `import { validateFiles } from '@longterm-wiki/crux'`.

The "composable library" vision in the target architecture section may be solving a problem that doesn't exist. The real benefits of the migration are:
1. **Type safety** catches bugs before runtime (especially in data-loading and frontmatter manipulation).
2. **Reduced boilerplate** makes validators easier to write and maintain.
3. **Single-process execution** is faster.

But "anyone can import these functions" is not a real use case today. Don't over-design the library API for hypothetical external consumers.

### 4. The subprocess pattern has real advantages the plan dismisses

The plan frames subprocesses as purely bad. But they provide:

- **Crash isolation.** If `validate-mermaid.mjs` hits an out-of-memory error parsing a 5000-line diagram, it crashes its own process and `validate-all.mjs` continues. In a single-process model, that crash kills everything.
- **Memory isolation.** The 15 validators run sequentially, and each process exits after completing. In a single-process model, all validators share one heap. The data loaded by `validate-mermaid.mjs` (Mermaid ASTs, etc.) stays in memory while `validate-style-guide.mjs` runs. For 625 MDX files, this could matter.
- **Independent executability.** Any developer can run `node crux/validate/validate-quality.mjs` to debug a single validator. After migration, they'd need to understand the library API, figure out how to call `checkQualityRatings()`, and handle the return type.
- **Incremental adoption.** A new developer can add a standalone validator script in 30 minutes by copying an existing one. Adding a library function + command handler + types is a steeper learning curve.

**The plan should distinguish between "eliminate all subprocesses" and "eliminate unnecessary subprocesses."** The validate-all orchestrator spawning 15 validators is fine architecturally — it's the boilerplate within each validator that's the problem.

### 5. Alternative approach: Keep scripts, share the runtime

Instead of converting scripts to library functions, provide a shared runtime context that each script can opt into:

```typescript
// lib/script-context.ts
export interface ScriptContext {
  args: ParsedArgs;
  colors: Colors;
  pages: PageEntry[];
  entities: Entity[];
  engine?: ValidationEngine;
  log: Logger;
}

export async function withContext(fn: (ctx: ScriptContext) => Promise<number>): Promise<void> {
  const args = parseScriptArgs();
  const colors = getColors(args.flags.ci);
  const log = createLogger(args.flags.ci);

  // Lazy-load data only when accessed
  const ctx: ScriptContext = {
    args,
    colors,
    log,
    get pages() { return loadPages(); },
    get entities() { return loadEntities(); },
  };

  const exitCode = await fn(ctx);
  process.exit(exitCode);
}
```

Each validator becomes:

```typescript
// validate/validate-quality.ts
import { withContext } from '../lib/script-context.ts';

withContext(async (ctx) => {
  // No boilerplate! ctx has args, colors, data, logging.
  const discrepancies = findQualityDiscrepancies(ctx.pages, ctx.args.options);

  for (const d of discrepancies) {
    ctx.log.warn(`${d.pageId}: quality=${d.current}, suggested=${d.suggested}`);
  }

  return discrepancies.length > 0 ? 1 : 0;
});
```

**Advantages over the full migration:**
- 10x less effort (just write `withContext` and migrate scripts incrementally)
- Scripts stay independently runnable
- Subprocess pattern preserved where useful
- No need to design library APIs or command handler rewrites
- Can be adopted file-by-file with zero coordination

**Disadvantages:**
- Doesn't give you type-safe return values between components
- Doesn't eliminate subprocess overhead
- Doesn't create composable functions

This might be the 80/20 solution: eliminate the boilerplate pain without the architectural overhaul.

### 6. Alternative approach: JSDoc types instead of .mjs → .ts conversion

TypeScript isn't the only way to add types. JSDoc annotations in `.mjs` files work with `checkJs: true`:

```javascript
// validate/validate-quality.mjs (stays .mjs, gets type checking)

/** @typedef {import('../lib/content-types.ts').PageEntry} PageEntry */

/**
 * @param {PageEntry[]} pages
 * @param {{threshold?: number, category?: string}} options
 * @returns {{pageId: string, current: number, suggested: number}[]}
 */
function findQualityDiscrepancies(pages, options) {
  // ... unchanged logic, now type-checked
}
```

**Advantages:**
- Zero file renames, zero import path changes, zero risk of breaking things
- Incremental — add JSDoc to one function at a time
- Works with the existing tsconfig (`allowJs: true`, just flip `checkJs: true`)
- No tsx runtime changes needed

**Disadvantages:**
- JSDoc types are verbose and ugly compared to TypeScript
- Complex types (generics, discriminated unions) are painful in JSDoc
- Some type constructs aren't expressible in JSDoc
- Developers tend to not maintain JSDoc types over time

This is worth considering for files that don't warrant full conversion — especially the authoring scripts where 43% of the code is prompt strings that don't benefit from types at all.

### 7. The prompts-in-code problem is unaddressed

43% of the authoring code (page-improver, grade-content) is prompt text embedded as template literals. The migration plan converts these files to TypeScript, which means:

- TypeScript will type-check the string interpolation in prompts (marginally useful)
- But it won't validate that the prompts are correct, coherent, or up-to-date
- Prompt changes are the most common changes to these files, and they'll now require TypeScript compilation to verify

**Consideration**: Should prompts be extracted into separate files (`.prompt`, `.md`, or `.yaml`) rather than embedded in TypeScript? This would:
- Make prompt editing easier (no need to understand TS)
- Enable prompt versioning and A/B testing
- Reduce the TypeScript migration scope significantly (page-improver drops from 935 to ~385 lines of actual logic)
- Allow non-developers to edit prompts

The plan doesn't mention this option at all.

### 8. The test infrastructure should be addressed before the migration, not after

The current test runner is a homegrown TAP-like system (`test(name, fn)` with try/catch). There's no test configuration, no watch mode, no coverage, and crux tests aren't run in CI (`pnpm test` only runs app vitest tests).

**This is a blocker for a safe migration.** Converting 34 rules to TypeScript without running the rule tests in CI means regressions can slip through. The plan's "verification" section says to diff `pnpm crux validate` output, but that's manual and fragile.

**What should happen first:**
1. Add a `test:crux` script to package.json
2. Run it in CI
3. Consider migrating to vitest (it's already used for app tests)
4. Add snapshot tests for validator output

This should be Phase 0d, not an afterthought.

### 9. Eager imports: a startup tax the plan ignores

`crux.mjs` eagerly imports all 9 domain modules:

```javascript
import * as validateCommands from './commands/validate.mjs';
import * as analyzeCommands from './commands/analyze.mjs';
// ... 7 more
```

When you run `pnpm crux validate`, you pay the import cost for insights, gaps, resources, generate, etc. After the migration, when validators are direct imports instead of subprocess dispatches, this gets worse — the validate command handler will import the entire validation engine, all 34 rules, all data loaders, etc. just to run `crux gaps list`.

**The plan should consider lazy imports:**

```typescript
const domains: Record<string, () => Promise<Domain>> = {
  validate: () => import('./commands/validate.ts'),
  analyze: () => import('./commands/analyze.ts'),
  // ...
};

const handler = await domains[domain]();
```

This is a small change but matters for CLI responsiveness.

### 10. The "recommended stopping points" may be traps

The plan says "Phases 0–1 is a good stopping point (~10 hours)." But after Phase 1, you have:
- 34 typed rules in `lib/rules/*.ts`
- 23 untyped standalone validators in `validate/*.mjs`
- 10 untyped lib files in `lib/*.mjs`
- A validation engine that loads typed rules but is called by untyped scripts

This is a coherent but odd state. The rules are typed but their callers aren't. The benefit is limited because the untyped scripts pass untyped data into the typed rules.

The more natural stopping point might be **Phase 0 only** (standardize data loading + arg parsing) or **Phases 0+2** (typed lib/ backbone). Phase 1 in isolation provides less value than it appears because the rules are already correct — they pass the existing tests.

### 11. What if the real problem isn't TypeScript or subprocesses?

Step back and ask: what actually causes pain in the current codebase?

- **Adding a new validation rule** is easy (copy an existing rule, modify the check function). The boilerplate is in the standalone validators, not the rules.
- **Debugging a failing validator** is easy because each script is standalone.
- **Modifying prompts** in authoring scripts is the most common change, and TypeScript won't help with that.
- **The actual bugs** (from MEMORY.md) are pre-existing validation failures in content, not in the tooling code.

The real pain points might be:
1. **No persistent state** — every invocation re-scans 625 files from disk
2. **No parallelization** — `validate-all.mjs` runs 15 validators sequentially
3. **No error recovery** — if `page-improver` fails mid-run, there's no retry/resume
4. **No observability** — logs go to stdout only, no audit trail
5. **Stale content-types** — `app/scripts/lib/content-types.mjs` and `crux/lib/content-types.ts` are manually kept in sync

A migration plan focused on these operational issues might deliver more value per hour than a TypeScript conversion.

### 12. Risk matrix

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Half-migrated state confuses contributors | High | Medium | Complete each phase atomically; never leave partial conversions |
| Effort overruns stall the migration at an awkward point | High | High | Do Phase 0 first; evaluate whether to continue based on actual vs. estimated time |
| Type errors in newly-converted files cascade into untyped callers | Medium | Low | Keep `checkJs: false`; only type-check converted files |
| Single-process model creates memory pressure with 625 files | Medium | Medium | Benchmark before and after; keep subprocess for MDX compile |
| Migration breaks `.claude/settings.local.json` permission patterns | Low | High | Entry point filenames must not change |
| Prompt editing becomes harder when embedded in TypeScript | Medium | Low | Consider extracting prompts to separate files |
| `tsx/esm` loader has edge cases with mixed .ts/.mjs imports | Medium | Medium | Test thoroughly; the existing 2 .ts files already prove this works |

### Summary: Revised recommendation

1. **Do Phase 0 first** (2–4h). It's pure upside — standardized data loading, shared arg parsing, de-duplicated imports. Zero risk.

2. **Then do the `withContext` alternative** (described in section 5 above) instead of the full Phase 3. This eliminates validator boilerplate in ~4 hours without changing the architecture.

3. **Add `test:crux` to CI** before any TypeScript conversion.

4. **Then evaluate**: is the remaining pain worth 40–60 more hours of TypeScript conversion? Or is the codebase already good enough?

The full 6-phase migration is the right plan *if you're committed to seeing it through*. The danger is starting it and stopping at Phase 2, leaving the codebase in a worse state than today.

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
