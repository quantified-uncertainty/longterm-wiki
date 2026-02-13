## 2026-02-13 | claude/add-llm-warning-banner-aWFt0 | Add LLM warning banner to wiki pages

**What was done:** Added a dismissible warning banner to all wiki pages informing readers that content was written by an LLM with minimal human supervision. The banner uses localStorage to persist dismissal, so once closed it stays hidden across all pages.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (known issue), `--ignore-scripts` workaround used

**Learnings/notes:**
- Banner is a client component (`"use client"`) since it needs useState/useEffect for localStorage
- Placed between ContentMeta (breadcrumbs) and the article content in the wiki page layout
- Defaults to hidden on initial render to avoid flash, then shows after checking localStorage
