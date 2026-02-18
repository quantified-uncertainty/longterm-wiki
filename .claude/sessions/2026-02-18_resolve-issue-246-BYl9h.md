## 2026-02-18 | claude/resolve-issue-246-BYl9h | Add YAML parse error handling in build-data.mjs

**What was done:** Added try-catch error handling around three unprotected `parse()` calls in `app/scripts/build-data.mjs` — in the path registry entity loader, facts loader, and fact-measures loader. The existing `loadYaml()` and `loadYamlDir()` functions already had error handling; this closes the remaining gaps. Fixes #246.

**Model:** opus-4-6

**Duration:** ~10min

**Issues encountered:**
- None

**Learnings/notes:**
- The `loadYaml()` and `loadYamlDir()` functions already had try-catch handling when the issue was filed, but three other `parse()` call sites in the same file did not.
