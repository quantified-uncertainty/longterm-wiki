## 2026-02-18 | claude/investigate-issue-273-aNlY2 | Improve crux issues next: weighted scoring + blocked detection

**What was done:** Implemented all four proposals from issue #273 — weighted scoring function (A), blocked issue detection (B), claude-ready label boost (C), and score breakdown display (D) — in `crux/commands/issues.ts`. Added 42 tests covering new and existing behavior.

**Pages:** (none — infrastructure only)

**Model:** sonnet-4

**Duration:** ~30min

**Issues encountered:**
- None

**Learnings/notes:**
- `on-hold` was already in SKIP_LABELS (silently filtered), so removed it from BLOCKED_LABELS to avoid confusion — on-hold issues remain hidden rather than shown as blocked
- Score total = priority + bugBonus + claudeReadyBonus + effortAdjustment + recencyBonus + ageBonus; claude-ready applies a 50% uplift on the base subtotal
- New `--scores` flag on both `list` and `next` shows inline breakdown for transparency
