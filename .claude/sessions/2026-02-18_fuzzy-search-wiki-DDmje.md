## 2026-02-18 | claude/fuzzy-search-wiki-DDmje | Resolve conflict resolver validation (issue #164)

**What was done:** Added numeric-id-integrity as a blocking validation rule to the gate, CI workflow, and resolve-conflicts workflow. Updated all documentation referencing "three blocking checks" to "four". Fixed resolve-conflicts auto-fix step to use separate commit (not amend) and detect both staged and unstaged changes.

**Pages:** architecture

**PR:** (auto-populated)

**Model:** opus-4-6

**Duration:** ~30min

**Issues encountered:**
- The initial commit missed adding numeric-id-integrity to CI workflow (ci.yml) and had outdated "three checks" references in CLAUDE.md and architecture.mdx
- The auto-fix commit step used `git commit --amend` which could obscure fix history, and `git diff --quiet` missed staged changes

**Learnings/notes:**
- The core validation gate was already added to resolve-conflicts.yml on Feb 17 (commit a16c92e), but the numeric-id-integrity rule was missing from both gate and CI
- When adding a new blocking check, must update: validate-gate.ts, ci.yml, CLAUDE.md (2 places), and architecture.mdx
- CRITICAL_RULES arrays in content-types.ts and page-improver/utils.ts are per-file authoring rules (not the same as CI gate checks) — they don't need numeric-id-integrity since it's a global/cross-file rule
