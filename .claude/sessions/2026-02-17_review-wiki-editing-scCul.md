## 2026-02-17 | claude/review-wiki-editing-scCul | Wiki editing system refactoring

**What was done:** Six refactors to the wiki editing pipeline: (1) extracted shared regex patterns to `crux/lib/patterns.ts`, (2) refactored validation in page-improver to use in-process engine calls instead of subprocess spawning, (3) split the 694-line `phases.ts` into 7 individual phase modules under `phases/`, (4) created shared LLM abstraction `crux/lib/llm.ts` unifying duplicated streaming/retry/tool-loop code, (5) added Zod schemas for LLM JSON response validation, (6) decomposed 820-line mermaid validation into `crux/lib/mermaid-checks.ts` (604 lines) + slim orchestrator (281 lines). Follow-up review integrated patterns.ts across 13 additional files, fixed dead imports, corrected ToolHandler type, and wired mdx-utils.ts to use shared patterns.

**Issues encountered:**
- build-data.mjs expects `/home/user/data/` directory which doesn't exist in sandbox environment (pre-existing)
- `executeWebSearch` uses Anthropic's `web_search_20250305` tool type which required keeping the raw API call rather than abstracting to `streamLlmCall`
- Review agent falsely flagged `validate/types.ts` as deleted — file never existed as standalone

**Learnings/notes:**
- The `ValidationEngine.load()` scans all MDX files on every call - `validateSingleFile` still loads everything but only checks the target file. A future optimization could lazy-load only the target + its cross-references.
- The page-improver's `validatePhase` still shells out for `fix escaping` and `fix markdown` because those auto-fixers aren't rule-based (they do direct file transforms). These could be converted to validation engine rules in a follow-up.
- When sharing regex patterns with `g` flag across files, prefer `.matchAll()` or `.match()` over `.exec()` loops to avoid shared `lastIndex` state.
- `callClaude()` in anthropic.ts returns `{text, usage, model}` while `streamLlmCall` returns just `string` — a future unified API could return usage metadata optionally.
