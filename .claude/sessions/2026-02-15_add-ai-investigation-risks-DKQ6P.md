## 2026-02-15 | claude/add-ai-investigation-risks-DKQ6P | Add AI-Powered Investigation Risks page

**What was done:** Created a new wiki page covering AI-powered investigation as a dual-use risk — how AI lowers the discoverability threshold for connecting public information, benefiting accountability (corruption detection, OSINT journalism) while threatening privacy through automated deanonymization and erosion of "privacy through obscurity." Added entity definition E694.

**Pages:** ai-investigation-risks

**Issues encountered:**
- OpenRouter API key expired/invalid (auth error with Clerk), preventing crux research-perplexity phase
- Crux synthesis phase spawns nested `claude` CLI session, which is blocked inside Claude Code environment
- Used `--source-file` workaround but synthesis still failed due to nested session limitation
- Wrote page manually following authoritarian-tools template (91/100 quality) as reference

**Learnings/notes:**
- When both OpenRouter and nested Claude Code are unavailable, the crux content creation pipeline cannot run at all
- The `--source-file` flag only skips research phases, not synthesis (which requires claude CLI)
- crux.mjs CLI parser only supports `--key=value` format, not `--key value` (space-separated)
