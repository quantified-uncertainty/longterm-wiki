## 2026-02-19 | claude/improve-documentation-JFCEy | Implement crux facts extract CLI command

**What was done:** Implemented `pnpm crux facts extract <page-id> [--apply]` CLI command (issue #202) — a new `facts` domain in the Crux CLI that scans wiki pages for volatile numbers not yet in `data/facts/*.yaml`, uses Claude Sonnet to classify fact candidates, and proposes (or applies) new YAML entries for human review.

**Pages:** (none — infrastructure only)

**Model:** sonnet-4-6

**Duration:** ~45min

**Issues encountered:**
- `vitest.config.ts` only included specific directories; added `facts/**/*.test.ts` to include the new test directory.
- `getColors(true)` would have suppressed colors; corrected to `getColors()` for auto-detection.

**Learnings/notes:**
- The `buildCommands` / `createScriptHandler` pattern in `crux/lib/cli.ts` makes adding new domains straightforward — just a script config + command handler.
- LLM system prompt quality matters: the detailed exclusion criteria (historical dates, non-entity stats) significantly reduced noise in extracted candidates.
- Fact ID format is 8-char hex via `randomBytes(4).toString('hex')`, matching existing `data/facts/*.yaml` style.

**Recommendations:**
- A future session could add `crux facts list` to show all pending `# AUTO-EXTRACTED` entries across all fact YAML files.
- Consider a `--entity=openai` filter for `--all` mode to scan only pages mentioning a specific entity.
