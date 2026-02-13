# Session Log

Reverse-chronological log of Claude Code sessions on this repo. Each session appends a summary before its final commit. See `.claude/rules/session-logging.md` for the format.

## 2026-02-13 | claude/optional-report-updates-lpTVT | Review fixes: DRY, types, docs, parser

**What was done:** PR review follow-up: extracted shared `formatAge`/`formatFrequency` utilities to `@lib/format.ts` (removed 3 duplicate implementations), added `evergreen` and `changeHistory` to crux `Frontmatter`/`PageEntry` types, hardened `parseSessionLog` regex against EOF edge cases, documented changeHistory system in automation-tools.mdx.

**Pages:** automation-tools

**Issues encountered:**
- None

**Learnings/notes:**
- `formatAge()` had three subtly different implementations (capitalization, abbreviation). Consolidated to one canonical version in `@lib/format.ts`.
- The session log parser's regex `(.+?)(?:\n\n|\n\*\*)` would fail if a field were the last thing before `---` or EOF. Added `\n---` as an alternative terminator.

---

## 2026-02-13 | claude/optional-report-updates-lpTVT | Connect session log to page change history

**What was done:** Added `Pages:` field to session log format, built a parser in build-data.mjs that extracts page-level change history from session log entries, added `changeHistory` to the Page interface, added a per-page "Change History" section in PageStatus (with timeline of sessions that touched the page), and created a master `/internal/page-changes` dashboard with a sortable/searchable table of all page changes grouped by session.

**Issues encountered:**
- None

**Learnings/notes:**
- Session log is available even in Vercel shallow clones (it's a committed file), making it more reliable than git log for build-time history extraction
- The parser uses regex on the markdown structure — fragile if format changes, but the format is well-defined in session-logging.md

---

## 2026-02-13 | claude/optional-report-updates-lpTVT | Add evergreen flag to opt out of update schedule

**What was done:** Added `evergreen: false` frontmatter field to allow pages (reports, experiments, proposals) to opt out of the update schedule. Full feature implementation: frontmatter schema + validation (evergreen: false + update_frequency is an error), Page interface + build-data, getUpdateSchedule(), bootstrap/reassign scripts, updates command, staleness checker, PageStatus UI (shows "Point-in-time content · Not on update schedule"), IssuesSection (no stale warnings for non-evergreen). Applied to all 6 internal report pages. Updated automation-tools docs.

**Pages:** automation-tools, ai-research-workflows, causal-diagram-visualization, controlled-vocabulary, cross-link-automation-proposal, diagram-naming-research, page-creator-pipeline

**Issues encountered:**
- reassign-update-frequency.ts had a bespoke string-only YAML parser that returned all values as strings, requiring `=== 'false'` workaround. Replaced with shared `parseFm` from mdx-utils.
- Graded format validation warned about missing update_frequency even when evergreen: false — contradictory rules.

**Learnings/notes:**
- Pages without `update_frequency` are already excluded from the schedule, but the bootstrap script would re-add it. The `evergreen: false` flag prevents this.
- The flag needed to be threaded through 8 different systems: schema, build, app data layer, UI, validation, staleness checker, updates command, and bootstrap/reassign scripts.
- reassign-update-frequency.ts was the only crux authoring script using a hand-rolled parser instead of the shared `yaml` library one — now fixed.

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
