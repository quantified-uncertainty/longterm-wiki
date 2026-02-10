## Context

The `crux/` directory contains the crux CLI (~98 files, ~625KB) for validation, analysis, content generation, and resource management. It was ported from the old cairn/Astro monorepo to the current Next.js setup across PRs #3-#8.

PR #8 ported the final 15 scripts, and the review branch (`claude/review-crux-library-DtZLf`) fixed critical bugs in those ported scripts — wrong data structures, missing fields, broken paths, data loss risks. The root cause of nearly every bug was **untyped JSON blobs**: scripts guessing field names (`database.entities` vs `database.typedEntities`), iterating wrong data shapes (`Object.entries(database)` expecting entities but getting top-level keys), and loading files that don't exist (`database.json` dependency when build produces individual files).

TypeScript would prevent this entire class of bug. But a blanket migration of all 98 files isn't worth the effort — the value concentrates in a few layers.

## Pre-requisites (do these first, they make the TS migration cleaner)

### 1. Extract `createScriptHandler` to `lib/cli.mjs`

Currently duplicated across 5 command files with minor variations:
- `commands/validate.mjs`
- `commands/fix.mjs`
- `commands/analyze.mjs`
- `commands/generate.mjs`
- `commands/content.mjs`

Extract to one config-driven function in `lib/cli.mjs`. Each command file becomes just a SCRIPTS map + `getHelp()`. This should be done before TS migration because it simplifies the command handler layer to the point where it doesn't need types.

### 2. Fix `rules/index.mjs` double-import

Every rule is imported twice (once as a named re-export, once for the `allRules` array). Single import, derive both:
```js
import { dollarSignsRule } from './dollar-signs.mjs';
export { dollarSignsRule };
export const allRules = [dollarSignsRule, ...];
```

### 3. Consolidate data loading

Multiple scripts construct their own paths to `app/src/data/*.json` and do raw `JSON.parse(readFileSync(...))`. Before typing, centralize all data loading into `lib/content-types.mjs` so there's one place to add types.

## TypeScript Migration Plan

### Phase 1: Type the data layer (`lib/content-types.ts`)

**Files:** `lib/content-types.mjs` → `lib/content-types.ts`

**Why this first:** This is the single change that prevents the entire class of "wrong field name" bugs. Every script that loads generated JSON should go through typed loaders.

**What to do:**

1. Import types from the existing `app/src/data/schema.ts` (Zod schemas already exist there for `Entity`, `EntityType`, `Resource`, `Publication`, etc.)

2. Add typed loader functions:
```ts
import { z } from 'zod';
import { Entity, Resource, Publication } from '../../app/src/data/schema.js';

// Types derived from what build-data.mjs actually produces
export interface BacklinkEntry {
  id: string;
  type: string;
  title: string;
  relationship: string;
}

export type PathRegistry = Record<string, string>;
export type BacklinksMap = Record<string, BacklinkEntry[]>;

export function loadEntities(): z.infer<typeof Entity>[] {
  return loadJson('entities.json', []);
}

export function loadBacklinks(): BacklinksMap {
  return loadJson('backlinks.json', {});
}

export function loadPathRegistry(): PathRegistry {
  return loadJson('pathRegistry.json', {});
}

export function loadOrganizations(): Array<{ id: string; name: string; shortName?: string }> {
  return loadJson('organizations.json', []);
}

export function loadExperts(): Array<{ id: string; name: string }> {
  return loadJson('experts.json', []);
}

export function loadPages(): Array<{
  title: string;
  path: string;
  importance?: number;
  quality?: number;
  wordCount?: number;
  category?: string;
  filePath?: string;
  unconvertedLinkCount?: number;
  convertedLinkCount?: number;
}> {
  return loadJson('pages.json', []);
}

function loadJson<T>(filename: string, fallback: T): T {
  const filepath = join(GENERATED_DATA_DIR_ABS, filename);
  if (!existsSync(filepath)) return fallback;
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}
```

3. Update all scripts to use these loaders instead of raw `JSON.parse`. This is the high-value part — scripts go from:
```js
const dbPath = join(DATA_DIR, 'database.json');
const database = JSON.parse(readFileSync(dbPath, 'utf-8'));
for (const [entityId, entity] of Object.entries(database)) { // BUG
```
to:
```ts
const entities = loadEntities();
for (const entity of entities) { // type-checked
```

**Scripts that currently load JSON directly (would use typed loaders instead):**
- `analyze/analyze-all.mjs` — loads `backlinks.json`, `entities.json`
- `analyze/analyze-entity-links.mjs` — loads `entities.json`, `pathRegistry.json`, `backlinks.json`
- `analyze/analyze-link-coverage.mjs` — loads `backlinks.json`, `pathRegistry.json`
- `fix/fix-cross-links.mjs` — loads `pathRegistry.json`, `organizations.json`, `experts.json`
- `fix-broken-links.mjs` — loads `pathRegistry.json`, `entities.json`
- `commands/gaps.mjs` — loads `pages.json`, insights from YAML
- `commands/insights.mjs` — loads insights from YAML
- `resource-manager.mjs` — loads `pages.json`
- `scan-content.mjs` — could use loaders
- `validate/validate-data.mjs` — loads various data files

### Phase 2: Type the validation engine (`lib/validation-engine.ts`)

**Files:** `lib/validation-engine.mjs` → `lib/validation-engine.ts`

**Interfaces to define:**
```ts
export interface Rule {
  id: string;
  name?: string;
  description?: string;
  scope: 'file' | 'global';
  ci?: boolean;          // Include in CI validation
  fixable?: boolean;     // Has auto-fix support
  check: (input: ContentFile | ContentFile[], engine: ValidationEngine) => Promise<Issue[]>;
}

export interface ContentFile {
  path: string;
  relativePath: string;
  raw: string;
  frontmatter: Record<string, unknown>;
  body: string;
  extension: 'mdx' | 'md';
  isIndex: boolean;
  directory: string;
  slug: string;
  urlPath: string;
}

export type FixType = 'replace-text' | 'replace-line' | 'insert-line-before' | 'insert-line-after';
export type Severity = 'error' | 'warning' | 'info';

export interface Fix {
  type: FixType;
  content?: string;
  oldText?: string;
  newText?: string;
}

export interface IssueParams {
  rule: string;
  file: string;
  line: number;
  message: string;
  severity: Severity;
  fix?: Fix;
}
```

**Why:** The 34 rule files all implement the `Rule` interface implicitly. Making it explicit catches scope/check signature mismatches at compile time. The `ci` and `fixable` metadata fields (currently absent) would enable removing the hardcoded `UNIFIED_CHECKS` map from `validate-all.mjs`.

### Phase 3: Type the rule files (`lib/rules/*.ts`)

**Files:** All 34 `lib/rules/*.mjs` → `lib/rules/*.ts`

This is mostly mechanical — add the `Rule` type annotation to each export:
```ts
import type { Rule } from '../validation-engine.js';

export const dollarSignsRule: Rule = {
  id: 'dollar-signs',
  scope: 'file',
  ci: true,
  fixable: true,
  check: async (file, engine) => { ... }
};
```

Benefits:
- `check` function signatures enforced
- `scope` must be `'file' | 'global'`
- Can add `ci` and `fixable` metadata to enable auto-discovery in `validate-all.mjs`

### Phase 4: Type remaining lib files

**Files to convert (in priority order):**
- `lib/insights.mjs` (17KB, complex data structures)
- `lib/mdx-utils.mjs` (frontmatter parsing — typing the return value catches bugs)
- `lib/file-utils.mjs` (simple, quick win)
- `lib/output.mjs` (simple, quick win)
- `lib/cli.mjs` (after createScriptHandler extraction)
- `lib/knowledge-db.mjs` (uses better-sqlite3, might need @types)
- `lib/redundancy.mjs`, `lib/metrics-extractor.mjs`

### What NOT to convert

- **`commands/*.mjs`** — After `createScriptHandler` extraction, these are just SCRIPTS maps and `getHelp()` strings. Types add nothing.
- **`validate/*.mjs`** — Legacy subprocess scripts being migrated to unified rules. Converting to TS is wasted effort; migrate to rules instead.
- **`content/*.mjs`** — Large AI-prompt-heavy scripts (grade-content.mjs at 37KB). The complexity is in prompt engineering, not data structures. Types add little value.
- **`auto-fix.mjs`, `scan-content.mjs`** — Standalone scripts, thin wrappers.
- **`resource-manager.mjs`** — 1967 lines, standalone CLI. Could benefit from types but the ROI is low given its size.

## Build/Runtime Setup

The project already has `tsx` as a devDependency and uses it for some scripts (e.g., `generate-schema-diagrams.mjs` has shebang `#!/usr/bin/env npx tsx`). The `tsconfig.json` in the app already exists.

For tooling TS files:
1. Add a `crux/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "paths": {
      "@app/*": ["../app/src/*"]
    }
  },
  "include": ["lib/**/*.ts", "commands/**/*.ts"],
  "references": [{ "path": "../app" }]
}
```

2. Run TS files with `tsx` (already available):
   - `crux.mjs` can detect `.ts` extensions and use `tsx` as runner
   - Or rename `crux.mjs` → `crux.ts` and run via `tsx crux/crux.ts`

3. Add a typecheck script: `"typecheck:crux": "tsc --noEmit -p crux/tsconfig.json"`

## Other Improvements (can be done independently)

### Consolidate validate-all.mjs subprocess checks → rules

These subprocess checks could be unified engine rules:
- `validate-sidebar-labels.mjs` → new rule
- `validate-orphaned-files.mjs` → `cruft-files` rule partially covers this
- `validate-mdx-syntax.mjs` → could be rules
- `validate-consistency.mjs` → `fact-consistency` rule exists

Each migration eliminates a subprocess spawn + file re-read, making `crux validate` faster.

### Add rule metadata for auto-discovery

Add `ci: boolean` and `fixable: boolean` fields to rules, then remove the hardcoded `UNIFIED_CHECKS` map in `validate-all.mjs`. New rules would be auto-included in CI without editing 3 files.

### Standardize option naming

- Pick `--json` over `--ci` for structured output (more descriptive)
- Pick `--fix` for all auto-fixers (some use `--apply`)
- Document in `crux --help`
