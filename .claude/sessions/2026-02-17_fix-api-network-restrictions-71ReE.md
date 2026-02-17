## 2026-02-17 | claude/fix-api-network-restrictions-71ReE | Fix API key sanitization for external research APIs

**What was done:** Added `getApiKey()` utility that strips embedded quotes from environment variables, applied it to all API key reading locations (OpenRouter, Firecrawl, Anthropic, SCRY), and added actionable error diagnostics distinguishing auth failures from credit exhaustion. The root cause of PR #179's "network restrictions" was actually embedded quotes in `OPENROUTER_API_KEY` and `FIRECRAWL_KEY` env vars, not network blocking.

**Issues encountered:**
- `OPENROUTER_API_KEY` had embedded double quotes (`"sk-or-v1-..."`) causing 502 auth failures
- `FIRECRAWL_KEY` had same issue, plus account has insufficient credits (billing issue)
- SCRY worked fine (uses hardcoded public key fallback)
- All API endpoints are network-reachable in Claude Code CLI environment

**Learnings/notes:**
- Claude Code CLI has NO network restrictions to research APIs (unlike web sandbox)
- The "network restrictions" reported in PR #179 were web-sandbox-specific; in CLI the actual issue is env var quoting
- Firecrawl credits are exhausted — needs billing action separate from code fix
