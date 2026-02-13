# Session Log

Reverse-chronological log of Claude Code sessions on this repo. Each session appends a summary before its final commit. See `.claude/rules/session-logging.md` for the format.

## 2026-02-13 | claude/resolve-issue-106-z3sVS | Enhanced search dialog (issue #106)

**What was done:** Implemented all three phases of the enhanced search dialog from issue #106: (1) entity type filter chips below the search input using ENTITY_GROUPS, with dynamic result counts per chip; (2) highlighted search snippets using MiniSearch match info to mark matching terms in descriptions; (3) sort toggle (Relevance/Quality/Recent) in the dialog footer. Also increased search doc description length from 160 to 300 chars for richer snippets, and exposed MiniSearch match/terms data through the SearchResult type.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (known issue); vitest and next binaries not in PATH, used direct node_modules paths

**Learnings/notes:**
- MiniSearch raw results include `match` (term→fields map) and `terms` arrays that are useful for highlighting
- Post-search filtering pattern (fetch 30 results, filter client-side) works well for the compact dialog

---

## 2026-02-13 | claude/wiki-gap-analysis-l7Cp8 | Systematic wiki gap analysis

**What was done:** Conducted a systematic gap analysis of the entire wiki corpus to identify missing topics and content needs. Created structured analysis across all major entity groups (organizations, people, concepts, etc.) and generated prioritized recommendations for new content.

**Issues encountered:**
- None

**Learnings/notes:**
- Gap analysis process helps identify systematic coverage issues rather than ad-hoc content additions
- Cross-referencing entity types reveals patterns in coverage gaps

---

## 2026-02-13 | claude/add-page-edit-descriptions-BwZBa | Fix 6 edit log review issues

**What was done:** Fixed all 6 issues from paranoid code review of the edit log PR. Critical: grading.ts was using `pageIdFromPath(finalPath)` on a temp path (resolved to "final" instead of actual page slug) — now uses sanitized `topic` parameter directly. Verified no actual slug collisions exist among ~625 pages. Added `default: list` command so `crux edit-log` works without subcommand. Changed all `logBulkFixes` callers to use per-page generic notes instead of misleading aggregate counts. Added `getDefaultRequestedBy()` helper (checks `CRUX_REQUESTED_BY` → `USER` → `'system'`) and wired it into all 4 pipeline call sites. Fixed falsy check in `appendEditLog` to use `!= null` so empty strings are preserved. Added 4 new tests (14 total edit-log tests, 269 total tests).

**Issues encountered:**
- No actual slug collisions found among non-index pages — the theoretical collision risk noted in review does not affect current content

**Learnings/notes:**
- Page IDs (slugs) are derived identically across the codebase (last path segment), so edit log IDs match `page.id` convention
- `getDefaultRequestedBy()` is the cleanest way to thread user identity without adding CLI flags to every pipeline

---

## 2026-02-13 | claude/add-page-edit-descriptions-BwZBa | Full edit log system integration

**What was done:** Fully integrated file-based edit log system across entire codebase. Per-page YAML files in `data/edit-logs/` track every page modification with tool, agency, requestedBy, and note fields. Integrated into 9 write paths: page create, improve, grade (x2), and 5 fix/validation scripts. Added `crux edit-log` CLI domain with view/list/stats commands. Added `crux validate edit-logs` validator. Documented in CLAUDE.md. 10 unit tests.

**Issues encountered:**
- First implementation was frontmatter-based; reworked to file-based after design review

**Learnings/notes:**
- Storing structured data in frontmatter is risky because LLMs rewrite the entire file during improve
- `logBulkFixes()` and `pageIdFromPath()` helpers simplify integration for fix scripts
- `crux/validate/types.ts` is imported but doesn't exist; dead import in several validators

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