## 2026-02-13 | claude/analyze-x-epistemics-UEHWy | Create X.com Platform Epistemics page + validation rules

**What was done:** Created a comprehensive analysis page for X.com's epistemic practices. After review, fixed a journal name mismatch (PNAS Nexus → Science) and restructured the Mermaid diagram to comply with the style guide. Then added two new validation rules to prevent these classes of issues in the future: `citation-doi-mismatch` (detects when link text contradicts URL DOI prefix) and `mermaid-style` (enforces max parallel nodes, total node count, and TD orientation). Both rules added to QUALITY_RULES for non-blocking advisory checks.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (known issue)
- better-sqlite3 native module needed manual rebuild (`npx node-gyp rebuild`)
- Crux content create pipeline's synthesis step hangs indefinitely (spawns `claude -p --print` subprocess that never completes)
- vitest and next binaries not on PATH after pnpm install; needed to invoke from full paths in node_modules

**Learnings/notes:**
- The `--source-file` flag in crux content create successfully bypasses external API research phases
- The synthesis step spawns a claude subprocess that may not work reliably in all environments
- Page was written manually following the knowledge-base-response template structure with proper frontmatter, EntityLinks, and citations
- The citation-doi-mismatch rule maps DOI prefixes (e.g., 10.1126 = Science) to expected journal names — catches a common LLM synthesis error
- The mermaid-style rule found 183 pre-existing warnings across the codebase, all non-blocking
