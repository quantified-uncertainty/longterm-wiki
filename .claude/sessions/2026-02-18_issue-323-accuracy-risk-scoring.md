## 2026-02-18 | claude/issue-323-accuracy-risk-scoring | Integrate accuracy data into hallucination-risk scoring

**What was done:** Added citation accuracy data as a new risk factor (Factor 7) in the hallucination-risk validator. Pages with LLM-verified inaccurate citations now receive additional risk points (5-20 depending on severity). Gracefully handles missing DB via dynamic import with file existence check.

**PR:** (auto)

**Model:** opus-4-6

**Duration:** ~20min

**Issues encountered:**
- Pre-existing test failures in `lib/lib.test.ts` and `lib/validators.test.ts` (relative path issues and missing old validator scripts) — not related to this change.

**Learnings/notes:**
- The `knowledge-db.ts` module eagerly creates the SQLite DB on import. Used `existsSync` check on DB file + dynamic import to avoid creating DB when it doesn't exist.
- The hallucination-risk validator is separate from the build-data pipeline's hallucinationRisk computation — the build-data version runs in CI (no SQLite) while the validator is local-only.
