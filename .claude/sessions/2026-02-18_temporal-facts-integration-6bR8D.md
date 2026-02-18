## 2026-02-18 | claude/temporal-facts-integration-6bR8D | Link facts to resources for citations

**What was done:** Added `sourceResource` field to the Facts system, linking canonical facts to the curated Resources database (3,137 entries). The build pipeline now resolves resource IDs to enrich facts with source title, publication name, and credibility scores. The `<F>` component tooltip shows rich citation info (source title, publication, credibility badge) when a resource is linked. YAML schema validation cross-references sourceResource IDs against known resources. Wired up all 4 existing sourced facts to resources (created 2 new resource entries for Reuters and Microsoft blog URLs).

**Pages:** (none — infrastructure only)

**Model:** opus-4-6

**Duration:** ~30min

**Issues encountered:**
- `pnpm install` fails (puppeteer postinstall) and `vitest` not found — pre-existing dependency issues, not related to changes

**Learnings/notes:**
- The build pipeline's auto-match feature (matching fact source URLs to resource URLs) found 0 matches because all facts with sources already had explicit sourceResource fields. This feature will be useful as more facts get sourced.
- Resources use hash IDs generated from URLs via `crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)`
