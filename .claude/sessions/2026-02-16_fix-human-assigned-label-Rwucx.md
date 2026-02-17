## 2026-02-16 | claude/fix-human-assigned-label-Rwucx | Fix "Human-assigned" quality label

**What was done:** Changed "Human-assigned" to "LLM-assigned" in the quality rating tooltip (PageStatus.tsx) and internal architecture docs. Added a crux validation rule (`human-attribution`) and a vitest source-code scan (`no-human-attribution.test.ts`) to prevent this from recurring.

**Pages:** architecture

**PR:** #159

**Issues encountered:**
- None

**Learnings/notes:**
- Validation rules only cover MDX content in `content/docs/`; source code (TSX/TS) needs separate vitest tests for lint-like checks
