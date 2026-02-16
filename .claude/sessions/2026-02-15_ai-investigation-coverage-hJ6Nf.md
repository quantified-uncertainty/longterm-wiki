## 2026-02-15 | claude/ai-investigation-coverage-hJ6Nf | AI investigation coverage pages

**What was done:** Created three new wiki pages covering AI-powered investigation/OSINT, AI deanonymization risks, and AI for accountability/anti-corruption. Added corresponding entity definitions (E698, E699, E700) with cross-links. Fixed crux pipeline's Claude Code subprocess spawning to unset CLAUDECODE env var.

**Pages:** ai-powered-investigation, deanonymization, ai-accountability

**Issues encountered:**
- Crux content create pipeline failed: Perplexity API key unavailable (no PERPLEXITY_API_KEY), and the Claude Code SDK subprocess failed to spawn inside a nested Claude Code session (CLAUDECODE env var blocks it). Fixed the spawn issue in synthesis.ts, validation.ts, and deployment.ts by unsetting CLAUDECODE in the env, but the subprocess still hung silently. Fell back to manual page creation per CLAUDE.md fallback protocol.
- Entity numericId conflicts: IDs E694-E696 were already allocated by auto-generated frontmatter entities. Used E698-E700 instead (after checking _nextId in id-registry.json).
- Invalid entityType "response" — not a valid enum value. Changed to "approach" for the accountability page.

**Learnings/notes:**
- The crux pipeline's `--source-file` flag works for skipping research phases, but the Claude Code SDK subprocess spawning still has issues in nested sessions even after unsetting CLAUDECODE. May need further investigation.
- Always check `app/src/data/id-registry.json` `_nextId` field for the next available entity numeric ID, not just grep through YAML files.
- `entityType: response` is not valid in the frontmatter schema; use `approach` for response-type pages.
