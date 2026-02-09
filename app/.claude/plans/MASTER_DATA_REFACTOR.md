# Master Data Refactor Plan

## Overview

Multi-phase effort to decouple the Next.js wiki frontend from the legacy Astro app's data layer. Originally planned as 4 phases within the cairn monorepo; the repo split (Feb 2025) changed the trajectory.

| Phase | Summary | Status |
|-------|---------|--------|
| **1** | Switch to longterm-next's own build script | **DONE** |
| **2** | Move entity transformation to build time | **DONE** |
| **Repo Split** | Extract wiki into standalone `longterm-wiki` repo | **DONE** |
| **3** | ~~Create `@cairn/data` package~~ → Superseded by repo split | **SUPERSEDED** |
| **4** | ~~Move YAML sources to package~~ → Done as part of repo split | **SUPERSEDED** |

---

## Current State (post-split)

### Repository: `longterm-wiki/`

```
longterm-wiki/
├── content/docs/               # ~625 MDX pages (was apps/longterm/src/content/docs/)
├── data/                       # YAML sources (was apps/longterm/src/data/)
│   ├── entities/               # 24 YAML files
│   ├── facts/                  # 4 YAML files
│   ├── resources/              # 10 YAML files
│   ├── insights/               # 6 YAML files
│   ├── graphs/                 # 4 YAML files
│   ├── *.yaml                  # Root YAML files
│   ├── id-registry.json        # Persistent ID mapping (committed)
│   └── schema.ts               # Zod schemas (from longterm app)
├── app/                        # Next.js 15 frontend (was apps/longterm-next/)
│   ├── src/
│   │   ├── data/index.ts       # Data layer (~973 lines, reads database.json)
│   │   ├── data/entity-schemas.ts
│   │   ├── data/entity-ontology.ts
│   │   ├── data/master-graph-data.ts
│   │   ├── data/parameter-graph-data.ts
│   │   └── lib/mdx.ts          # MDX compilation
│   ├── scripts/
│   │   ├── build-data.mjs      # Generates database.json from ../data/ and ../content/
│   │   └── lib/                # Build script modules
│   ├── package.json
│   └── vercel.json
├── tooling/                    # Crux CLI + validation (was apps/longterm/scripts/)
│   ├── crux.mjs
│   ├── commands/
│   ├── lib/rules/
│   └── validate/
├── package.json                # Workspace root
└── pnpm-workspace.yaml
```

### Build flow

```
app/scripts/build-data.mjs
  → reads YAML from ../data/
  → reads MDX frontmatter from ../content/docs/
  → transforms entities at build time (entity-transform.mjs)
  → writes app/src/data/database.json

app/src/data/index.ts
  → reads database.json (local, or falls back to ../data/)
  → validates typedEntities via Zod schemas
  → provides lookup functions to React components
```

### Key changes from repo split

1. **@cairn/ui inlined** — `cn()`, Collapsible, and Mermaid copied into app. No workspace dependency.
2. **Path references updated** — All `../longterm/src/data/` → `../data/`, `../longterm/src/content/docs/` → `../content/docs/`
3. **Vercel config** — `installCommand: "cd .. && npx pnpm@9 install"` (one level up, not two)
4. **Tooling paths** — `src/content/docs` → `content/docs`, `src/data` → `data` (relative to repo root)

---

## Phase 1 Completion Notes (2025-02-09)

All steps completed. Key outcomes:
- **Step 1.0**: Untracked build scripts committed as baseline
- **Step 1.1**: Functional equivalence verified — 631 entities match, 587 pages match
- **Step 1.2**: `frontmatter-scanner.mjs` created and wired in; entity-transform.mjs bugs fixed (default case + null safety)
- **Step 1.3 & 1.4**: `prebuild` and `sync:data` updated in package.json
- **Step 1.5**: Full Next.js build passes
- **Critical bugs fixed**: Missing `scanFrontmatterEntities` and default case dropping extra fields

---

## Phase 2 Completion Notes (2025-02-09)

All steps completed. Key outcomes:
- **Steps 2.1 & 2.2**: entity-transform.mjs bugs fixed and `transformEntities()` wired into build-data.mjs producing `typedEntities` in database.json (631 entities)
- **Step 2.3**: `typedEntities` added to `DatabaseShape` interface
- **Step 2.4**: `getTypedEntities()` rewritten to read pre-built `db.typedEntities`. On Zod parse failure for unknown types (ai-transition-model-*), raw objects are pushed directly to preserve extra fields
- **Step 2.5**: `applyEntityOverrides()` call removed from `getDatabase()`
- **Step 2.6**: Deleted ~274 lines of dead code
- **Step 2.7**: Test mocks updated with pre-transformed `typedEntities`
- **Step 2.8**: All 24 data tests pass. `index.ts` 1247 → 973 lines (-274)

---

## Repo Split Completion Notes (2025-02-09)

The repo split superseded Phases 3 and 4. What those phases aimed to achieve:

| Original Phase 3/4 Goal | How the repo split addressed it |
|---|---|
| Decouple from `apps/longterm/` | Wiki is now its own repo — no dependency on cairn at all |
| Create `@cairn/data` package | Not needed — data layer lives in `app/src/data/`, YAML in `data/` |
| Move YAML sources to package | YAML lives at repo root `data/` — accessible to both app and tooling |
| Inline `@cairn/ui` | Done — cn(), Collapsible, Mermaid copied into app |
| Share data across cairn apps | No longer a goal — wiki is standalone |

---

## Remaining Work / Future Improvements

These are potential follow-up tasks, not committed phases:

### Data layer cleanup
- [x] Remove the `LONGTERM_DATA_DIR` fallback pattern from `index.ts`, `mdx.ts`, etc. — simplified to single direct paths
- [x] Simplify `getDatabase()` — reads directly from `src/data/database.json`
- [x] Strip raw `entities` array from database.json (only `typedEntities` needed) — database.json reduced, entities.json kept for validation

### Tooling
- [x] Fix Astro-specific validators in `tooling/` — sidebar/type validators skip gracefully when Astro config not found
- [x] Update tooling to run from repo root — added `yaml`, `zod`, `js-yaml` to root package.json; fixed remaining `src/data/` path refs in insights/gaps commands (23/28 validators pass)
- [x] Pre-existing test failure: `claude-code-espionage-2025` has type `event` — added `event` to entity ontology (53/53 tests pass)

### Build pipeline
- [x] `master-graph-data.ts` reads from `../data/graphs/` directly (no local fallback)
- [ ] LLM files generation could move to tooling — deferred, tightly coupled to app build (reads database.json, writes to app/public/)

### Tooling — remaining pre-existing issues (not regressions)
- [ ] `validate-yaml-schema.mjs` needs `npx tsx` but validate-all runs it with `node` — needs tsx integration
- [ ] `validate-component-refs` reports 6457 errors — likely Astro component import pattern mismatches
- [ ] `validate-entity-links` — entity link conversion checks
- [ ] `validate-mdx-compile` — MDX compilation errors in some pages
- [ ] `validate-internal-links` — 24 broken internal links

### Deployment
- [ ] Set up Vercel project for `longterm-wiki` repo (root directory: `app/`)
- [ ] DNS/domain migration from old deployment

---

## Historical Context

### Red-Teaming Findings (resolved)

These were identified during planning and fixed in Phases 1-2:

1. **CRITICAL (fixed Phase 1)**: Missing `scanFrontmatterEntities()` — frontmatter-only entities would silently disappear
2. **CRITICAL (fixed Phase 1)**: `entity-transform.mjs` default case dropped extra fields for ATM entities
3. **MEDIUM (fixed Phase 1)**: Missing null-safety in `applyEntityOverrides()`
4. **MEDIUM (no longer applicable)**: Missing `transpilePackages` for `@cairn/data` — package was never created
5. **LOW (documented)**: `getEntityHref()` has hardcoded `/wiki/` prefix — acceptable, only one consumer

### Commands Reference

```bash
# In longterm-wiki repo:
cd app && node scripts/build-data.mjs    # Generate database.json
pnpm test                                 # Run vitest tests
npx next build                            # Full production build
pnpm dev                                  # Dev server on port 3001

# From repo root:
pnpm build                               # Build via workspace
pnpm test                                # Test via workspace
node tooling/crux.mjs validate           # Run validation suite
```
