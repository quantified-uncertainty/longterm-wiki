## 2026-02-18 | claude/improve-conflict-resolution-nUEsp | Improve conflict resolution: two-tier + dedup

**What was done:** Overhauled the conflict resolution workflow with three improvements: (1) fingerprint-based deduplication to stop repeated failed attempts, (2) visible error output from validate-gate in CI mode, and (3) a two-tier resolution system — Sonnet handles text-level conflict markers first (fast/cheap), then Claude Code SDK escalates agentically if validation fails (can read errors, edit files, run commands iteratively).

**Pages:**

**PR:**

**Model:** opus-4-6

**Duration:** ~45min

**Issues encountered:**
- The validate-gate.ts suppressed all child process output in CI mode (when `CI=true`), making it impossible to debug why the build-data step failed from workflow logs
- The workflow posted identical failure comments every 2 hours without checking if it had already tried the same SHA combination

**Learnings/notes:**
- The conflict resolver successfully removes conflict markers but can produce semantically broken code (e.g., mixing ID formats). Tier 2 (Claude Code) can iteratively fix these.
- Claude Code CLI can run headless in CI via `claude -p "prompt" --dangerously-skip-permissions --model sonnet`
- Using `continue-on-error: true` + `always()` conditions in GitHub Actions to chain the two tiers without one blocking the other
