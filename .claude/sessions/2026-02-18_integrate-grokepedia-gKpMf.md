## 2026-02-18 | claude/integrate-grokepedia-gKpMf | Integrate Grokipedia as external link platform

**What was done:** Added Grokipedia as a new external link platform (alongside LessWrong, Wikipedia, etc.) and populated 171 page-to-Grokipedia mappings — 65 derived from existing Wikipedia links, 106 from high-confidence title matching for person and organization pages.

**Pages:** grokipedia

**Issues encountered:**
- DNS resolution blocked in this environment (`EAI_AGAIN`), so HTTP-based URL verification against grokipedia.com was not possible. Used Wikipedia-derived slugs and conservative title matching instead.
- `pnpm install` fails on puppeteer postinstall; workaround with `--ignore-scripts`.

**Learnings/notes:**
- Grokipedia URL pattern: `https://grokipedia.com/page/Article_Name` (Wikipedia-style slugs)
- The `crux grokipedia match` command supports live HTTP checking for future use when network access is available
- The offline script (`crux/scripts/grokipedia-from-wikipedia.mjs`) is useful as a fallback when DNS is blocked
