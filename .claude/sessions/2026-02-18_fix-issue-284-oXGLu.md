## 2026-02-18 | claude/fix-issue-284-oXGLu | Extend resilient JSON parsing to visual-review, generate-summaries, reassign-update-frequency

**What was done:** Moved `parseJsonFromLlm` from the page-improver-specific `phases/json-parsing.ts` to the shared `crux/lib/json-parsing.ts`, then updated `visual-review.ts`, `generate-summaries.ts`, and `reassign-update-frequency.ts` to use it instead of plain `JSON.parse`.

**Pages:** (none — infrastructure-only)

**Model:** sonnet-4

**Duration:** ~20min

**Issues encountered:**
- None

**Learnings/notes:**
- The phases `json-parsing.ts` now re-exports `parseJsonFromLlm` from `crux/lib/` for backward compatibility with existing phase imports
- For `reassign-update-frequency.ts`, fallback throws (not returns) to preserve existing retry behavior
