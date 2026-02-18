## 2026-02-18 | claude/improve-conflict-resolution-nUEsp | Improve conflict resolution: dedup + diagnostics

**What was done:** Fixed two issues with the automated conflict resolution workflow: (1) added fingerprint-based deduplication so the resolver doesn't repeatedly attempt the same failed resolution when nothing has changed, and (2) fixed validate-gate to show error output in CI mode so failure comments include actual diagnostics instead of just "build-data failed".

**Pages:**

**PR:**

**Model:** opus-4-6

**Duration:** ~30min

**Issues encountered:**
- The validate-gate.ts suppressed all child process output in CI mode (when `CI=true`), making it impossible to debug why the build-data step failed from workflow logs
- The workflow posted identical failure comments every 2 hours without checking if it had already tried the same SHA combination

**Learnings/notes:**
- The conflict resolver successfully removes conflict markers but can produce semantically broken code (e.g., mixing ID formats). The fingerprint dedup prevents wasting API calls on these cases.
- Future improvement: Claude Code SDK-based agentic resolution that can iteratively fix validation errors
