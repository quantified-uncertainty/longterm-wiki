## 2026-02-16 | claude/issue-161-implementation-yz3r9 | Add API-direct mode for crux pipeline

**What was done:** Implemented `--api-direct` flag for `crux content create` that uses the Anthropic API directly instead of spawning `claude` CLI subprocesses. Auto-detects when Claude CLI is unavailable and switches automatically. Also added graceful fallback for Perplexity research when OPENROUTER_API_KEY or network is unavailable. Follow-up: fixed 5 review findings (dead null checks, duplicate ensureComponentImports, greedy JSON regex, context interface mismatch, missing help text).

**Pages:** (none — infrastructure change)

**PR:** #166

**Issues encountered:**
- None

**Learnings/notes:**
- The page-improver (`page-improver.ts`) already uses the Anthropic API directly — only the page-creator had subprocess dependencies
- Three subprocess calls were replaced: synthesis, validation loop, and review
- The validation loop API-direct version runs programmatic checks + Claude fix iterations instead of giving Claude full Bash access
- Research fallback was added at the Perplexity and SCRY levels to handle missing API keys or network failures gracefully
- `createClient()` defaults to `required: true` and throws on missing key — null checks after it are dead code
- `parseJsonResponse` from `anthropic.ts` is better than greedy regex for extracting JSON from Claude responses
