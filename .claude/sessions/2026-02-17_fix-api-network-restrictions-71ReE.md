## 2026-02-17 | claude/fix-api-network-restrictions-71ReE | Fix API key sanitization and proxy support for research APIs

**What was done:** Fixed two independent issues preventing external research APIs from working in the crux pipeline: (1) Added `getApiKey()` utility that strips embedded quotes from environment variables, applied to all API key reading locations including Anthropic SDK constructors and GitHub Actions scripts; (2) Added `NODE_USE_ENV_PROXY=1` to package.json scripts so Node.js `fetch()` respects HTTP_PROXY env vars in proxy environments. Also added actionable error diagnostics for auth vs credit failures.

**Issues encountered:**
- `OPENROUTER_API_KEY` and `FIRECRAWL_KEY` had embedded double quotes causing auth failures
- Node.js `fetch()` ignores `HTTPS_PROXY` env var by default — `curl` works but `fetch` doesn't in proxy environments
- `NODE_USE_ENV_PROXY=1` env var (Node 22.21+) fixes the proxy issue; it's ignored on older Node versions

**Learnings/notes:**
- The sandbox container routes ALL outbound traffic through an HTTP proxy (visible via `HTTPS_PROXY` env var)
- `curl` uses the proxy automatically; Node.js `fetch()` does NOT unless `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` is set
- This proxy issue is the actual root cause of PR #179's "network restrictions" — ALL external API calls via `fetch()` fail without proxy config
- API key quoting is a secondary issue that also needs fixing
- After both fixes: OpenRouter, SCRY, Firecrawl all confirmed working end-to-end
