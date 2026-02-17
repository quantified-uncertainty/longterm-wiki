## 2026-02-17 | claude/review-pr-92-UquRc | Add Calc component + fact-aware pipelines

**What was done:** Implemented `<Calc>` component from closed PR #92. Removed broken mechanical `crux fix facts` tool. Built fact-aware content pipelines: both `crux content improve` and `crux content create` now inject a per-page fact lookup table so the LLM can semantically wrap values with `<F>` tags. Integrated into grading criteria (concreteness rewards fact usage, checklist flags unwrapped values). Updated CLAUDE.md with conventions and self-review checklist.

**Pages:** anthropic-ipo, anthropic-valuation

**Issues encountered:**
- PR #92 branch was deleted from remote, so the implementation was rebuilt from the PR diff
- Mechanical batch fact retrofitter had fatal false-positive problem: same dollar amounts in different semantic contexts got wrapped with wrong fact IDs
- Reverted all 29 batch-applied content files; kept only manually verified pages

**Learnings/notes:**
- Mechanical regex-based fact matching fundamentally can't work — requires semantic understanding
- The right approach: give the LLM the fact lookup table during content pipelines (parallel to entity lookup tables)
- Integration points for new components: CLAUDE.md conventions, grading criteria, creator synthesis, improver prompt, self-review checklist
- Facts get wrapped incrementally as pages go through the improve pipeline, not via batch application
