# Content Scripts Refactoring Guide

These scripts were ported from the cairn monorepo with minimal changes (path adjustments only). They carry significant technical debt that should be addressed in a follow-up branch.

## Priority 1: Security Fixes

### page-improver.mjs — Shell injection in SCRY search
**Lines ~237-255.** Uses `execSync` + `curl` with user-influenced query interpolated into a shell command. `$(...)` in a query would execute arbitrary commands.

**Fix:** Replace with `fetch()` like page-creator.mjs already does for the same SCRY API.

### page-improver.mjs — Unrestricted file read
**Lines ~184-185.** The `read_file` tool handler reads any path on the filesystem with zero validation. Prompt injection in page content could exfiltrate `.env`, SSH keys, etc.

**Fix:** Restrict paths to project root: `if (!toolUse.input.path.startsWith(ROOT)) return 'Access denied';`

## Priority 2: Bug Fixes

### page-improver.mjs — gap-fill phase never executes
In the `deep` tier, phases are `['analyze', 'research-deep', 'improve', 'validate', 'gap-fill', 'review']`. The `gap-fill` phase uses `review` results, but `review` comes *after* `gap-fill`. So `review` is always `undefined`, and gap-fill short-circuits.

**Fix:** Swap `gap-fill` and `review` in the deep tier phases array.

### page-improver.mjs — validation validates old content
The validation phase writes improved content to a temp file but runs `node tooling/crux.mjs validate` against the whole project (old content on disk). The validation is meaningless.

**Fix:** Write improved content to the actual file path before validation, or validate the temp file directly.

### page-creator.mjs — runSynthesis called with wrong args
**Line ~2360.** Single-phase handler passes `'opus'`/`'sonnet'` as the `quality` parameter, but the function expects `'standard'`/`'fast'`/`'quality'`. Premium tier synthesis always runs on sonnet.

**Fix:** Change to `tier === 'premium' ? 'quality' : 'standard'`.

### page-creator.mjs — sidebar coverage is dead code
Imports `checkSidebarCoverage` from `sidebar-utils.mjs`, which reads `astro.config.mjs` (doesn't exist). Always returns `{ covered: false }`.

**Fix:** Either remove sidebar coverage checks, or update `sidebar-utils.mjs` to parse the Next.js navigation config.

### page-creator.mjs — stale component references in synthesis prompt
**Line ~1234.** The prompt instructs Claude to import `KeyPeople`, `KeyQuestions`, `Section` from `@components/wiki` — these don't exist.

**Fix:** Update to only reference components that actually exist in `@components/wiki`.

### page-creator.mjs — dead `validate-quick` phase
**Lines ~2153-2157.** Returns `{ success: true }` and charges phantom $0.50. Not referenced in any tier.

**Fix:** Delete it.

## Priority 3: Split page-creator.mjs (~2,400 lines)

Proposed module structure under `tooling/content/creator/`:

| Module | ~Lines | Contents |
|---|---|---|
| `duplicate-detection.mjs` | 120 | `levenshteinDistance`, `similarity`, `toSlug`, `checkForExistingPage` |
| `canonical-links.mjs` | 90 | `CANONICAL_DOMAINS`, `findCanonicalLinks` |
| `research.mjs` | 100 | `runPerplexityResearch`, `runScryResearch` |
| `source-fetching.mjs` | 120 | `registerResearchSources`, `fetchRegisteredSources`, `getFetchedSourceContent`, `processDirections`, `extractUrls` |
| `synthesis.mjs` | 240 | `getSynthesisPrompt`, `runSynthesis` |
| `verification.mjs` | 200 | `runSourceVerification` |
| `validation.mjs` | 200 | `runValidationLoop`, `runFullValidation`, `ensureComponentImports` |
| `grading.mjs` | 150 | `GRADING_SYSTEM_PROMPT`, `runGrading` |
| `deployment.mjs` | 80 | `deployToDestination`, `createCategoryDirectory`, `validateCrossLinks` |
| `index.mjs` | 200 | Pipeline runner, CLI arg parsing, `main()` |

The existing `page-creator.mjs` would become a thin entry point that imports from `creator/index.mjs`.

## Priority 4: Deduplicate Against Shared Libs

### page-improver.mjs — bypass of shared anthropic lib
Imports `@anthropic-ai/sdk` directly instead of using `../lib/anthropic.mjs`. Reimplements agent loop, JSON parsing, client creation without rate limiting or error handling.

**Fix:** Use `createClient()`, `parseJsonResponse()`, `MODELS` from `../lib/anthropic.mjs`. Extract the agent loop (tool-use conversation) to a shared helper if needed.

### page-creator.mjs — `ensureComponentImports` duplication
**Lines ~391-486.** Near-exact duplicate of `tooling/lib/rules/component-imports.mjs`.

**Fix:** Import and call the existing validation rule's fix function instead.

### grade-content.mjs — duplicated utilities
- `extractFrontmatter()` duplicates `parseFrontmatter()` from `tooling/lib/mdx-utils.mjs`
- `collectPages()` duplicates `findMdxFiles()` from `tooling/lib/file-utils.mjs`
- `computeMetrics()` duplicates `extractMetrics()` from `tooling/lib/metrics-extractor.mjs`
- Direct `client.messages.create()` call (line ~604) should use `callClaude()` from `../lib/anthropic.mjs`
- Missing `mkdirSync` for output directory `.claude/temp/grades-output.json`

### grade-by-template.mjs — duplicated metric functions
- `countWords()`, `countTables()`, `countCitations()`, `hasDiagram()` duplicate `tooling/lib/metrics-extractor.mjs`
- `PAGE_TEMPLATES` (~200 lines inline) should be a separate data file

### Hardcoded SCRY API key
Both page-creator.mjs and page-improver.mjs hardcode `exopriors_public_readonly_v1_2025`. Should be in `.env` with a fallback default.

## Priority 5: Add Tests

After the refactoring above, good candidates for unit tests:
- `duplicate-detection.mjs`: `levenshteinDistance`, `similarity`, `toSlug`, `checkForExistingPage`
- `extractUrls`: URL extraction with parenthesis balancing
- `ensureComponentImports`: import detection and fixing
- Shared validation rule constants: verify arrays match what the validation engine expects
- `verification.mjs`: quote attribution detection, name verification
