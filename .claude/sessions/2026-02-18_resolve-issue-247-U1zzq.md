## 2026-02-18 | claude/resolve-issue-247-U1zzq | Fix CauseEffectGraph silent layout failure

**What was done:** Fixed CauseEffectGraph layout failure handling so the UI no longer gets stuck on "Computing layout..." indefinitely. Added a 10-second timeout, improved error banner styling with proper CSS, and added a retry button.

**Model:** opus-4-6

**Duration:** ~15min

**Issues encountered:**
- None

**Learnings/notes:**
- The component already had basic error handling (catch block, layoutError state), but lacked a timeout for hung computations and had poor error UX (inline styles, no retry option).
