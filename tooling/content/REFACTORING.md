# Content Scripts Refactoring Guide

These scripts were ported from the cairn monorepo with minimal changes (path adjustments only). The tech debt documented below has been addressed.

## Status: COMPLETED

All items below have been implemented. See the commit history for details.

## Priority 1: Security Fixes ✅

### page-improver.mjs — Shell injection in SCRY search ✅
Replaced `execSync` + `curl` with `fetch()` API. No more shell command interpolation.

### page-improver.mjs — Unrestricted file read ✅
Added path validation: `read_file` handler now resolves the path and rejects anything outside `ROOT`.

### Hardcoded SCRY API key ✅
Both page-creator.mjs and page-improver.mjs now use `process.env.SCRY_API_KEY` with a fallback default.

## Priority 2: Bug Fixes ✅

### page-improver.mjs — gap-fill/review phase ordering ✅
Swapped `gap-fill` and `review` in the deep tier phases array so review runs first and gap-fill can use review results.

### page-improver.mjs — validation validates old content ✅
Validation phase now writes improved content to the actual file path before running validators, then restores the original content afterward (via try/finally).

### page-creator.mjs — runSynthesis called with wrong args ✅
Changed to `tier === 'premium' ? 'quality' : 'standard'` to match the function signature.

### page-creator.mjs — sidebar coverage is dead code ✅
Removed `checkSidebarCoverage` import and all sidebar coverage checks. Next.js auto-detects pages from filesystem.

### page-creator.mjs — stale component references in synthesis prompt ✅
Updated import template from `{EntityLink, Backlinks, KeyPeople, KeyQuestions, Section}` to `{EntityLink, Backlinks, R, DataInfoBox, DataExternalLinks}` (components that actually exist).

### page-creator.mjs — dead `validate-quick` phase ✅
Deleted the dead code block.

## Priority 3: Split page-creator.mjs ✅

Split from ~2,400 lines into modules under `tooling/content/creator/`:

| Module | Contents |
|---|---|
| `duplicate-detection.mjs` | `levenshteinDistance`, `similarity`, `toSlug`, `checkForExistingPage` |
| `canonical-links.mjs` | `CANONICAL_DOMAINS`, `findCanonicalLinks` |
| `research.mjs` | `runPerplexityResearch`, `runScryResearch` |
| `source-fetching.mjs` | `registerResearchSources`, `fetchRegisteredSources`, `getFetchedSourceContent`, `processDirections`, `extractUrls` |
| `synthesis.mjs` | `getSynthesisPrompt`, `runSynthesis` |
| `verification.mjs` | `runSourceVerification` |
| `validation.mjs` | `runValidationLoop`, `runFullValidation`, `ensureComponentImports` |
| `grading.mjs` | `GRADING_SYSTEM_PROMPT`, `runGrading` |
| `deployment.mjs` | `deployToDestination`, `createCategoryDirectory`, `validateCrossLinks`, `runReview` |
| `index.mjs` | Re-exports all modules |

`page-creator.mjs` is now a thin CLI entry point (~500 lines) with configuration, utilities, pipeline runner, and CLI argument parsing.

## Priority 4: Deduplicate Against Shared Libs ✅

### page-creator.mjs — `ensureComponentImports` ✅
Replaced inline implementation with delegation to shared `componentImportsRule` from `tooling/lib/rules/component-imports.mjs`.

### grade-content.mjs — duplicated utilities ✅
- `extractFrontmatter()` → delegates to `parseFrontmatter()` from `tooling/lib/mdx-utils.mjs`
- `collectPages()` → uses `findMdxFiles()` from `tooling/lib/file-utils.mjs`
- Direct `client.messages.create()` → replaced with `callClaude()` from `../lib/anthropic.mjs`
- Added `mkdirSync` for output directory

### grade-by-template.mjs — duplicated metric functions ✅
- `countWords()`, `countTables()` → imported from `tooling/lib/metrics-extractor.mjs` (newly exported)
- `hasDiagram()` → delegates to `countDiagrams()` from metrics-extractor
- `countCitations()` → delegates to `countInternalLinks()` from metrics-extractor

### WIKI_COMPONENTS list ✅
Updated `tooling/lib/rules/component-imports.mjs` to match actual exports from `app/src/components/wiki/index.ts`.

### metrics-extractor.mjs — exported counting functions ✅
Made `countWords`, `countTables`, `countDiagrams`, `countInternalLinks`, `countExternalLinks` public exports so other scripts can reuse them.

## Priority 5: Tests ✅

Added test files:
- `tooling/content/creator/creator.test.mjs` — 21 tests for duplicate detection and URL extraction
- `tooling/lib/metrics-extractor.test.mjs` — 23 tests for exported metric functions

All existing tests continue to pass (lib.test.mjs: 24/24, validators.test.mjs: 35/35 logic tests, vitest: 45/45).

## Remaining Items (not addressed)

- **page-improver.mjs — bypass of shared anthropic lib**: Still imports `@anthropic-ai/sdk` directly for the agent loop (tool-use conversation). The agent loop pattern doesn't fit `callClaude()` which is single-turn. Would need a new shared helper.
- **grade-by-template.mjs — PAGE_TEMPLATES inline data**: ~200 lines of template definitions remain inline. Could be externalized to a JSON/YAML file but is low priority.
