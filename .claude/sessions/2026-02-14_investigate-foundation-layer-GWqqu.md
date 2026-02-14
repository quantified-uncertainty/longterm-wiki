## 2026-02-14 | claude/investigate-foundation-layer-GWqqu | Investigate Foundation-layer.ai

**What was done:** Fully investigated foundation-layer.ai. The site is a Framer-built philanthropic guide by Tyler John (Effective Institutions Project, formerly Longview Philanthropy) aimed at persuading philanthropists to fund AI safety. Content extracted via Jina reader proxy (r.jina.ai) since the Framer site is entirely JS-rendered. The site contains 13 pages covering AGI timelines, existential risks, a five-pillar philanthropic strategy, and a getting-started guide for donors.

**Pages:** (none — research only, no wiki pages created)

**Issues encountered:**
- Direct WebFetch of the Framer site returned only CSS/JS boilerplate with no readable content
- Site is not indexed by Google despite open robots.txt — likely too new
- Solved by using Jina AI reader proxy (r.jina.ai) which renders JS before extracting content

**Learnings/notes:**
- For JS-rendered sites (Framer, Next.js SSR-disabled, SPAs), use `https://r.jina.ai/<url>` as a workaround to extract content
- The Foundation Layer is highly relevant to the longterm-wiki: covers AGI timelines, alignment, compute governance, biodefense, AI consciousness, and philanthropic funding landscape — all topics with existing wiki pages
- Tyler John leads AI work at EIP, previously built Longview Philanthropy's AI team ($60M+ in grants), advises donors on $200M+ in planned giving
- The site references many organizations already in the wiki (METR, Apollo Research, Anthropic, OpenAI, DeepMind, Longview Philanthropy, Blueprint Biosecurity, etc.)
- Could be cited as a resource on relevant wiki pages (AI safety funding, philanthropic landscape, AGI timelines)
