# Crux Library Review & Refactoring Plan

Review of the `crux/` directory structure, the crux CLI architecture, and
recommendations for further improvements.

---

## Current State Summary

The crux CLI (`crux/crux.mjs`) is a domain-based CLI with 8 domains and ~98
files totaling ~625 KB. Recent work (PRs #3-#6) ported content scripts from the
old cairn monorepo, extracted shared rules, split the monolithic page-creator
into 9 modules, and cleaned up post-Starlight migration cruft.

**What works well:**
- Domain-based CLI model (`crux <domain> <command>`)
- Unified validation engine with 34 composable rules
- Declarative fix specifications attached to issues
- Single-pass file loading shared across rules
- Clean separation: `commands/` (thin wrappers) / `lib/` (logic) / `validate/` (scripts)

**What needs work:**
- 15 missing scripts referenced by command handlers
- Two incompatible command patterns (subprocess vs direct)
- Duplicated `createScriptHandler()` across 5 files
- Validation still split between unified engine and legacy subprocess scripts
- Rules index imports every rule twice (named exports + `allRules` array)
- No directory structure for `fix/`, `generate/`, `analyze/` scripts

---

## Problem 1: 15 Ghost Scripts

The most urgent issue. These command handlers reference scripts that don't exist:

**fix.mjs** (4 missing):
- `auto-fix.mjs` (the `fix all` default command)
- `fix-broken-links.mjs`
- `fix/fix-cross-links.mjs`
- `fix/fix-component-imports.mjs`

**analyze.mjs** (4 missing):
- `analyze/analyze-all.mjs`
- `analyze/analyze-link-coverage.mjs`
- `analyze/analyze-entity-links.mjs`
- `scan-content.mjs`

**generate.mjs** (6 missing):
- `generate/generate-yaml.mjs`
- `generate/generate-summaries.mjs`
- `generate/generate-data-diagrams.mjs`
- `generate/generate-schema-diagrams.mjs`
- `generate/generate-schema-docs.mjs`
- `generate/generate-research-reports.mjs`

**resources.mjs** (1 missing):
- `resource-manager.mjs`

### Recommendation

These were likely planned for porting from the cairn monorepo but never made it
over. Two options:

**Option A: Remove the dead commands.** Strip `fix.mjs`, `analyze.mjs`,
`generate.mjs`, and `resources.mjs` down to only the commands that actually work
(i.e., those that delegate to `validate/validate-unified.mjs` or other existing
scripts). Add a comment noting which commands are awaiting implementation.

**Option B: Create stub scripts** that print "Not yet implemented" and exit 0, so
the CLI doesn't silently fail.

Option A is cleaner. The dead commands give false confidence in `crux --help`.

---

## Problem 2: Duplicated `createScriptHandler()`

The function `createScriptHandler()` is copy-pasted across 5 files with minor
variations:

| File | Variation |
|------|-----------|
| `commands/validate.mjs` | Base pattern |
| `commands/fix.mjs` | Adds `config.extraArgs` support |
| `commands/analyze.mjs` | Adds `extraArgs` + positional args |
| `commands/generate.mjs` | Adds positional args |
| `commands/content.mjs` | Adds positional args |
| `commands/resources.mjs` | Different pattern entirely (single script) |

### Recommendation

Extract a single `createScriptHandler(name, config)` into `lib/cli.mjs`. The
config object already has all the needed fields: `script`, `passthrough`,
`extraArgs`, `positional`, `runner`. The handler logic is identical apart from
these config-driven branches. A unified version:

```js
// lib/cli.mjs
export function createScriptHandler(name, config) {
  return async function (args, options) {
    const scriptArgs = optionsToArgs(options, ['help']);
    const filteredArgs = scriptArgs.filter(arg => {
      const key = arg.replace(/^--/, '').split('=')[0];
      const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return config.passthrough.includes(camelKey) || config.passthrough.includes(key);
    });

    if (config.extraArgs) filteredArgs.push(...config.extraArgs);

    if (config.positional) {
      const positionals = args.filter(a => !a.startsWith('-'));
      filteredArgs.unshift(...positionals);
    }

    const streamOutput = !options.ci && !options.json;
    const result = await runScript(config.script, filteredArgs, {
      runner: config.runner || 'node',
      streamOutput,
    });

    return options.ci || options.json
      ? { output: result.stdout, exitCode: result.code }
      : { output: '', exitCode: result.code };
  };
}
```

Each command file then becomes just a SCRIPTS map + `getHelp()`.

---

## Problem 3: Dual Command Patterns

The codebase has two incompatible patterns:

**Pattern A: Subprocess wrappers** (validate, analyze, fix, content, generate, resources)
- Define a SCRIPTS map
- `createScriptHandler()` spawns a child process
- Options are serialized to CLI args and back
- Each script re-parses args, re-reads files, re-initializes

**Pattern B: Direct handlers** (insights, gaps)
- Export command functions directly
- Load data in-process
- Format output directly
- No subprocess overhead

### Problems with Pattern A

1. **Performance**: Each subprocess re-reads files from disk. `validate-all.mjs`
   mitigates this for unified rules but subprocess checks still thrash the
   filesystem.

2. **Option round-tripping**: camelCase → kebab-case → camelCase is lossy and
   bug-prone. The `passthrough` arrays are a manual allowlist that must be kept
   in sync.

3. **Error surfaces**: Subprocess errors surface as exit codes, losing structured
   error information. CI mode tries to pass JSON through stdout but it's fragile.

4. **Boilerplate**: Each validate script has its own arg parsing, file loading,
   and output formatting.

### Recommendation

Gradually migrate toward Pattern B (direct handlers). The unified validation
engine already proves this works for rules. The migration path:

1. **Keep subprocess pattern only for heavy/isolated scripts** that need their
   own Node.js memory space (MDX compilation, potentially tsx-based scripts).

2. **Convert simple validators to rules.** Most of the 15 subprocess checks in
   `validate-all.mjs` could be unified engine rules. Candidates:
   - `validate-sidebar.mjs` → already partially covered by `sidebar-index` rule
   - `validate-sidebar-labels.mjs` → new rule
   - `validate-orphaned-files.mjs` → already a `cruft-files` rule exists
   - `validate-mdx-syntax.mjs` → could be rules
   - `validate-consistency.mjs` → `fact-consistency` rule exists

3. **For non-validation domains** (insights, gaps), the direct handler pattern is
   already working. Extend it to analyze commands, replacing subprocess-based
   analyze scripts.

---

## Problem 4: Rules Index Double-Import

`lib/rules/index.mjs` imports every rule **twice**: once as a named re-export
(lines 9-59) and again as an import for the `allRules` array (lines 62-94).

### Recommendation

Use a single import and derive both:

```js
import { dollarSignsRule } from './dollar-signs.mjs';
import { comparisonOperatorsRule } from './comparison-operators.mjs';
// ... all imports ...

// Re-export for individual access
export { dollarSignsRule, comparisonOperatorsRule, /* ... */ };

// Collect all for bulk registration
export const allRules = [dollarSignsRule, comparisonOperatorsRule, /* ... */];
```

This cuts the file from 151 lines to ~80 and eliminates the maintenance burden
of keeping two lists in sync.

---

## Problem 5: Directory Structure Gaps

Current layout:

```
crux/
├── commands/      # 8 command handlers
├── content/       # Content creation/grading scripts
├── hooks/         # Git hooks
├── lib/           # Shared utilities + validation engine + rules/
└── validate/      # 24 validation scripts
```

Missing directories referenced by commands:
- `fix/` (fix-cross-links.mjs, fix-component-imports.mjs)
- `generate/` (6 generation scripts)
- `analyze/` (3 analysis scripts)

And loose scripts are referenced at the tooling root level:
- `auto-fix.mjs`
- `fix-broken-links.mjs`
- `resource-manager.mjs`
- `scan-content.mjs`

### Recommendation

Either create the directories and port/write the scripts, or remove references.
A clean target structure:

```
crux/
├── crux.mjs           # CLI entry point
├── commands/          # Domain command handlers (thin wrappers)
├── lib/               # Core library code
│   ├── rules/         # Validation rules (34 files)
│   ├── cli.mjs        # CLI utilities + createScriptHandler
│   ├── output.mjs     # Formatting
│   ├── validation-engine.mjs
│   ├── insights.mjs
│   ├── knowledge-db.mjs
│   └── ...
├── scripts/           # Executable scripts (subprocess targets)
│   ├── validate/      # Validation scripts
│   ├── content/       # Content creation/grading
│   ├── fix/           # Fix scripts (when ported)
│   ├── generate/      # Generation scripts (when ported)
│   └── analyze/       # Analysis scripts (when ported)
└── hooks/             # Git hooks
```

The key change: rename `validate/` to `scripts/validate/` and nest all script
subdirectories under `scripts/`. This clarifies the distinction between library
code (`lib/`) and runnable scripts (`scripts/`).

---

## Problem 6: validate-all.mjs Hybrid Approach

`validate-all.mjs` runs two phases:
1. Unified engine (single-pass, fast) for 13 rule-based checks
2. Subprocess execution for 15 legacy scripts

This works but has problems:
- Content files are loaded twice (once by engine, once by each subprocess)
- The UNIFIED_CHECKS map duplicates rule IDs that are already in the rules
- Adding a new rule requires editing 3 places: the rule file, rules/index.mjs,
  and validate-all.mjs's UNIFIED_CHECKS

### Recommendation

Long-term: migrate all subprocess checks into the unified engine. Short-term:

1. **Tag rules with metadata** so validate-all can auto-discover which rules to
   run in CI:

   ```js
   export const dollarSignsRule = {
     id: 'dollar-signs',
     scope: 'file',
     ci: true,           // Include in CI validation
     severity: 'error',  // Default severity
     fixable: true,
     check: (file) => { ... }
   };
   ```

2. **Remove UNIFIED_CHECKS map** in validate-all.mjs. Instead, filter `allRules`
   by `rule.ci === true`.

3. **Create a subprocess check registry** similar to rules, so new checks are
   discoverable:

   ```js
   // validate/registry.mjs
   export const subprocessChecks = [
     { id: 'data', script: 'validate-data.mjs', ... },
     { id: 'mdx-compile', script: 'validate-mdx-compile.mjs', ... },
   ];
   ```

---

## Problem 7: Naming Inconsistencies

### Option Naming
- `--dry-run` vs `--dryRun` (both used due to camelCase conversion)
- `--fail-fast` vs `--failFast`
- `--ci` vs `--json` (both mean "structured output" in different contexts)
- `--apply` vs `--fix` (both mean "make changes")

### Script Naming
- Validation scripts: `validate-*.mjs` (consistent)
- Fix scripts: mixed (`auto-fix.mjs`, `fix-broken-links.mjs`, `fix/fix-*.mjs`)
- Content scripts: no prefix pattern

### Recommendation
- Standardize on kebab-case for CLI flags, camelCase internally (already
  partially done)
- Pick one verb for "apply changes": `--fix` for auto-fixers, `--apply` for
  destructive operations
- Pick one flag for "structured output": `--json` (more descriptive than `--ci`)
- Content scripts should be `content-*.mjs` or nested under `content/`
  (already the case)

---

## Problem 8: insights.mjs vs gaps.mjs Data Loading

Both `insights.mjs` and `gaps.mjs` load insights data but from different
locations:

- `insights.mjs` (command handler): loads from `data/insights.yaml` (single file)
- `gaps.mjs` (command handler): loads from `data/insights/*.yaml` (directory of files)
- `lib/insights.mjs` (library): loads from a path passed as parameter

This suggests the data format is in transition (single file → directory of
files). The command handlers shouldn't contain data-loading logic at all.

### Recommendation

Consolidate into `lib/insights.mjs`:
- Add a `loadInsightsFromDir(dir)` function alongside the existing
  `loadInsights(path)` function
- Command handlers should call the library, not implement their own loading
- Resolve which format is canonical (single file or directory)

---

## Problem 9: Path Resolution Inconsistencies

Three different patterns for resolving the project root:

1. `process.cwd()` (content-types.mjs) - Assumes CLI is run from repo root
2. `join(__dirname, '..', '..')` (insights.mjs, gaps.mjs) - Relative to file
3. `SCRIPTS_DIR` in cli.mjs (join(__dirname, '..')) - Relative to lib/

### Recommendation

Use a single `PROJECT_ROOT` constant from `content-types.mjs`. It already exists
but isn't used consistently. Change it from `process.cwd()` to use `__dirname`
relative resolution so it works regardless of where the CLI is invoked from:

```js
// lib/content-types.mjs
const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, '..', '..');  // crux/../..
```

---

## Problem 10: Large Monolithic Content Files

Despite the recent split of page-creator.mjs, some files remain very large:

| File | Lines | KB |
|------|-------|----|
| `content/grade-content.mjs` | ~984 | 37 |
| `content/grade-by-template.mjs` | ~520 | 22 |
| `content/page-improver.mjs` | ~917 | ~35 |
| `lib/insights.mjs` | ~450+ | 17 |
| `lib/validation-engine.mjs` | ~350+ | 13 |

### Recommendation

Not urgent, but `grade-content.mjs` at 37 KB is a refactoring target. Its
3-step pipeline (warnings, structure, rating) maps naturally to 3 modules.
The `page-creator.mjs` split is a good template for how to do this.

---

## Prioritized Refactoring Plan

### Phase 1: Clean Up (Low risk, high impact)

1. **Remove ghost commands** that reference missing scripts. Mark them as
   "planned" in help text rather than silently failing.
2. **Extract `createScriptHandler`** to `lib/cli.mjs`. Deduplicate across all
   5 command files.
3. **Fix rules/index.mjs** double-import.
4. **Standardize `PROJECT_ROOT`** resolution.

### Phase 2: Consolidate Validation (Medium risk, high impact)

5. **Add rule metadata** (`ci`, `fixable`, default severity).
6. **Migrate easy subprocess checks** to unified rules (sidebar-labels,
   orphans, mdx-syntax).
7. **Remove UNIFIED_CHECKS** hardcoded map from validate-all.mjs.
8. **Unify insights data loading** in lib/insights.mjs.

### Phase 3: Structural Improvements (Medium risk, medium impact)

9. **Restructure to `scripts/` directory** for all runnable scripts.
10. **Standardize option naming** (`--json`, `--fix`, `--apply`).
11. **Port remaining scripts** from cairn monorepo (fix/, generate/, analyze/,
    resources) or remove placeholders.

### Phase 4: Architecture (Higher risk, long-term)

12. **Migrate subprocess commands to direct handlers** where feasible.
13. **Split monolithic content files** (grade-content.mjs).
14. **Add integration tests** for crux.mjs CLI itself.
15. **Add tab completion** and `crux doctor` self-diagnosis command.

---

## Quick Wins (Can Do Right Now)

These are small, safe changes that improve the codebase immediately:

1. **rules/index.mjs**: Remove duplicate imports (5 min)
2. **Remove broken `fix all` default**: It references `auto-fix.mjs` which
   doesn't exist. `crux fix` silently fails right now.
3. **Add `--help` to fix/generate/analyze/resources** showing which commands are
   actually available vs planned.
4. **Extract createScriptHandler to lib/cli.mjs** (30 min)
5. **Standardize PROJECT_ROOT** (15 min)
