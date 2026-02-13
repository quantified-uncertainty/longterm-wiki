# Session Log

Reverse-chronological log of Claude Code sessions on this repo. Each session appends a summary before its final commit. See `.claude/rules/session-logging.md` for the format.

## 2026-02-13 | claude/fix-broken-wiki-links-RWnZ9 | Fix broken EntityLinks on E689

**What was done:** Fixed two broken EntityLinks on the Concentrated Compute as a Cybersecurity Risk page (E689). Created a new `nvidia` entity (E693) in organizations.yaml since it was referenced by 4 pages but had no entity definition, causing it to appear as a broken "Concept" link. Changed `<EntityLink id="google-deepmind">` to `<EntityLink id="deepmind">` to use the correct existing entity ID (E98).

**Issues encountered:**
- Non-existent EntityLink IDs default to type `concept` in the related graph builder, causing organizations like NVIDIA to appear under "Concepts" section

**Learnings/notes:**
- `build-data.mjs` assigns `type: 'concept'` as default for any EntityLink target that doesn't have an entity definition — this is how broken links end up under "Concepts" in the Related Pages section
- The YAML schema validates RelatedEntry structure but does NOT validate that referenced entity IDs actually exist

---

## 2026-02-13 | claude/wiki-gap-analysis-l7Cp8 | Systematic wiki gap analysis

**What was done:** Ran `crux gaps list`, `crux gaps stats`, and manual topic coverage analysis across all 639 wiki pages. Identified 386 pages needing insight extraction (203 high-importance with zero insights). Produced a gap analysis report at `content/docs/internal/gap-analysis-2026-02.mdx`. Built a Suggested Pages dashboard (`app/internal/suggested-pages/`) with exactly 100 ranked page suggestions (priorities 1–100) in a sortable DataTable, using numeric priority based on mention frequency across existing pages (grep + EntityLink counts) and editorial importance. Updated gap-analysis MDX to reference the dashboard instead of inline tier lists.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (known issue), `--ignore-scripts` workaround used
- `crux gaps` shows 0 pages when `pages.json` hasn't been built — must run `node app/scripts/build-data.mjs` first
- The gaps tool only finds under-extracted existing pages, not truly missing topics — manual analysis needed for coverage gaps
- Numbered lists starting at >1 without blank lines fail the markdown list formatting test

**Learnings/notes:**
- 93% of tracked pages (482/519) have zero insights — massive insight extraction backlog
- Responses category (136 pages, 3% insight coverage) and organizations (106 pages, 0%) are most under-extracted
- Biggest content gaps: Chinese AI labs (DeepSeek, Mistral), test-time compute, hallucination, prompt injection — all lack dedicated pages
- Only 2 incident pages exist despite many documented AI failures

---

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

---

## 2026-02-13 | claude/review-wiki-report-XQW88 | Review and rewrite E686 OpenClaw Matplotlib Incident

**What was done:** Two-pass review and rewrite of the E686 wiki page. First pass: cut redundant theoretical sections, added investigative sections ("The Agent's Identity and Background", "Was This Really an Autonomous Agent?"), added HN stats, PR reaction ratios, agent apology, Klymak quote, media coverage. Second pass: deep investigation of agent's digital footprint — found two git commit emails (`crabby.rathbun@gmail.com` and `mj@crabbyrathbun.dev`), the `crabbyrathbun.dev` domain purchase, GitHub Issues #4/#17/#24 revealing SOUL.md refusal and operator acknowledgment, commit timestamp analysis, 26 computational chemistry forks, pump.fun memecoins (\$569K peak market cap), and zero-following GitHub pattern. Added 13 new sources total.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (known issue), `--ignore-scripts` workaround used

**Learnings/notes:**
- The `crabbyrathbun.dev` domain WHOIS is the strongest unexplored lead for operator identification
- pump.fun tokens were created AFTER virality (Feb 13), not by the operator — opportunistic third parties
- Commit timestamps for human-setup activities cluster at 18:00-19:00 UTC (ambiguous timezone)

---

## 2026-02-13 | claude/add-llm-warning-banner-aWFt0 | Add LLM warning banner to wiki pages

**What was done:** Added a dismissible warning banner to all wiki pages informing readers that content was written by an LLM with minimal human supervision. The banner uses localStorage to persist dismissal, so once closed it stays hidden across all pages.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (known issue), `--ignore-scripts` workaround used

**Learnings/notes:**
- Banner is a client component (`"use client"`) since it needs useState/useEffect for localStorage
- Placed between ContentMeta (breadcrumbs) and the article content in the wiki page layout
- Defaults to hidden on initial render to avoid flash, then shows after checking localStorage

---

## 2026-02-13 | claude/fix-sidebar-link-styles-2tINm | Fix InfoBox sidebar link styles

**What was done:** Updated the InfoBox "Related Entries" section to use `EntityLink` components instead of plain `Link` components, giving sidebar links the same background color styling and hover tooltip popups as main content links. Added `id` field to resolved related entries in the data layer, changed InfoBox Card from `overflow-hidden` to `overflow-visible` so tooltips aren't clipped, fixed `pluralize()` bugs ("analysises" → "analyses", "persons" → "people"), and tightened Related section spacing with a flex-wrap layout.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (known issue), `--ignore-scripts` workaround used

**Learnings/notes:**
- The InfoBox Card previously used `overflow-hidden` which would clip any absolutely-positioned tooltips; changed to `overflow-visible` with rounded header corners instead
- The `pluralize()` helper needed both a -sis → -ses rule and an irregular plurals map

---

## 2026-02-13 | claude/find-ai-revenue-pages-PEKvH | Investigate LLM crawlability of longtermwiki.com

**What was done:** Investigated why LLMs can't find longtermwiki.com pages via web search. Found the site already has comprehensive llms.txt infrastructure (llms.txt, llms-core.txt, llms-full.txt, per-page .txt files) generated by build-data.mjs. Added `LLMs-Txt` directive to robots.txt. Identified relevant AI revenue pages (ai-revenue-sources, projecting-compute-spending, anthropic-valuation, economic-disruption, etc.). Root cause is likely low domain authority/backlinks rather than technical SEO issues.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (network issue), but `--ignore-scripts` works fine
- build-data.mjs must be run from app/ directory (uses process.cwd() for path resolution)

**Learnings/notes:**
- The llms.txt system is already well-implemented — files are generated during build and served from public/
- llms*.txt files are gitignored (generated at build time), which is correct since Vercel runs build-data.mjs
- The site's main discoverability issue is search engine indexing, not technical configuration — recommend submitting sitemap to Google Search Console and Bing Webmaster Tools

---

## 2026-02-13 | claude/session-logging-tracking-d4d6K | Add session logging system

**What was done:** Created a session logging and common-issues tracking system. Added `.claude/rules/session-logging.md` (instructs each session to log a summary), `.claude/session-log.md` (the log itself), and `.claude/common-issues.md` (recurring issues and solutions seeded from CLAUDE.md knowledge).

**Issues encountered:**
- None

**Learnings/notes:**
- Hook-based logging (SessionStart/SessionEnd) captures metadata but not what actually happened. Rule-based self-logging is more useful for understanding session outcomes.
- The `.claude/rules/` directory is read automatically by Claude Code — no settings.json needed for rules.

---
