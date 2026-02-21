# Server + PostgreSQL Refactor Plan

## Executive Summary

The wiki-server (Hono + PostgreSQL + Drizzle ORM) currently handles two concerns: **entity ID allocation** (3 endpoints) and **citation quote/content storage** (11 endpoints). Meanwhile, a massive amount of operational and derived data lives in ~800+ YAML files and an 11MB monolithic JSON build artifact. This document identifies what should move to the database, what should stay as files, and a phased migration plan.

---

## Current Architecture

### What's in PostgreSQL (wiki-server, port 3100)
| Table | Rows | Purpose |
|---|---|---|
| `entity_ids` | ~873 | Numeric ID allocation via sequence |
| `citation_quotes` | ~1500+ | Extracted quotes with verification metadata |
| `citation_content` | varies | Cached webpage snapshots for verification |

### What's in SQLite (crux local cache, `.cache/knowledge.db`)
| Table | Purpose |
|---|---|
| `articles` | MDX page metadata cache |
| `sources` | External URL/paper cache |
| `article_sources` | Article-source cross-references |
| `summaries` | AI-generated summaries |
| `claims` | Extracted factual claims |
| `entity_relations` | Entity relationship cache |
| `citation_quotes` | Local mirror of PG citation_quotes |
| `citation_content` | Local mirror of PG citation_content |

### What's in YAML files (git-tracked)
| Location | Files | Size | Type |
|---|---|---|---|
| `data/entities/*.yaml` | 24 | ~2MB | Content (754 entities) |
| `data/facts/*.yaml` | 5 | ~50KB | Content (247+ facts) |
| `data/resources/*.yaml` | 10 | **~30MB** | Content (papers.yaml alone is 27MB) |
| `data/graphs/*.yaml` | 4 | ~250KB | Content (causal models) |
| `data/edit-logs/*.yaml` | ~625 | ~415KB | Operational (per-page edit history) |
| `data/citation-archive/*.yaml` | varies | ~200KB | Operational (URL verification cache) |
| `data/citation-accuracy/pages/*.yaml` | ~20 | ~120KB | Operational (accuracy verdicts) |
| `data/auto-update/` | ~15 | ~1.2MB | Operational (runs, seen items, state) |
| `data/reviews/` | 0 | 0 | Operational (empty, not yet used) |
| `data/reader-importance-ranking.yaml` | 1 | ~30KB | Derived (645 page rankings) |
| `.claude/sessions/*.yaml` | 170 | ~296KB | Operational (session audit trail) |

### What's in generated JSON (build artifacts, gitignored)
| File | Size | Contents |
|---|---|---|
| `database.json` | 11MB | Master compiled data (all entities, pages, facts, backlinks, related graph, etc.) |
| `pages.json` | 2.8MB | Page metadata + metrics |
| `search-index.json` | 497KB | MiniSearch full-text index |
| `search-docs.json` | 315KB | Search result metadata |
| `entities.json` | 1.9MB | Typed entity data |
| `backlinks.json` | 776KB | Reverse reference graph |
| `relatedGraph.json` | 1.75MB | Multi-signal semantic relatedness |
| + 10 more | ~2MB | Domain-specific indexes |

---

## Design Principles

1. **Keep version-controlled content in files.** Entities, facts, MDX pages, and graphs are *content* that benefits from git history, diffs, PRs, and code review. These stay as YAML/MDX.

2. **Move operational/temporal data to the database.** Edit logs, session logs, auto-update runs, citation verification results accumulate over time. They benefit from queries, aggregations, and don't need git diffs.

3. **Move large reference data to the database.** The resources collection (30MB of YAML) is unwieldy in git. It grows unboundedly and is never meaningfully diffed.

4. **Store derived data in the database for query access.** Backlinks, related graph, hallucination risk scores, page rankings — currently recomputed from scratch at build time. DB storage enables incremental updates and live dashboards.

5. **YAML files remain source of truth for content; DB is source of truth for operations.** Dual-write patterns (write YAML + sync to DB) are acceptable during migration but should converge.

---

## Tier 1: High Impact, Natural Fit

These are the strongest candidates — operational data that's currently scattered across hundreds of YAML files with no query capability.

### 1.1 Edit Logs

**Current state:** 625 YAML files in `data/edit-logs/`, one per page. Append-only. ~3K+ entries total.

**Problems:**
- No cross-page queries ("show all crux-improve edits in last week")
- No aggregations ("which tool is used most?", "edit frequency by agency")
- Dashboard must scan all 625 files to build a view

**Proposed schema:**
```sql
CREATE TABLE edit_logs (
  id BIGSERIAL PRIMARY KEY,
  page_id TEXT NOT NULL,
  date DATE NOT NULL,
  tool TEXT NOT NULL,           -- crux-create, crux-improve, crux-fix, etc.
  agency TEXT NOT NULL,         -- human, ai-directed, automated
  requested_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_edit_logs_page ON edit_logs(page_id);
CREATE INDEX idx_edit_logs_date ON edit_logs(date);
CREATE INDEX idx_edit_logs_tool ON edit_logs(tool);
```

**API endpoints:**
- `POST /api/edit-logs` — append an edit log entry
- `POST /api/edit-logs/batch` — bulk insert (for migration)
- `GET /api/edit-logs?page_id=X` — get edit history for a page
- `GET /api/edit-logs?since=DATE&tool=X` — cross-page query
- `GET /api/edit-logs/stats` — aggregate statistics (tool distribution, agency distribution, edits per day)

**Migration:** One-time script reads all `data/edit-logs/*.yaml` files, inserts into DB. Crux `edit-log.ts` updated to write to DB via API (with file fallback for offline use). YAML files can be kept as backup initially, then deprecated.

**Consumers affected:**
- `crux/lib/edit-log.ts` — switch from YAML read/write to API calls
- `crux/commands/edit-log.ts` — `view`, `list`, `stats` commands query API
- `apps/web/src/app/internal/page-changes/` — read from API instead of parsing session logs

---

### 1.2 Session Logs

**Current state:** 170 YAML files in `.claude/sessions/`. Each captures date, branch, title, pages modified, summary, issues, learnings.

**Problems:**
- Regex-based parsing in `session-log-parser.mjs` is fragile
- No efficient "which sessions modified page X?" query
- No cost/duration analytics across sessions
- Growing unboundedly as more sessions happen

**Proposed schema:**
```sql
CREATE TABLE sessions (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  branch TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  model TEXT,
  duration TEXT,
  cost TEXT,
  pr_url TEXT,
  checks_yaml TEXT,            -- agent-checklist snapshot
  issues_json JSONB,           -- blockers encountered
  learnings_json JSONB,        -- insights discovered
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE session_pages (
  session_id BIGINT REFERENCES sessions(id),
  page_id TEXT NOT NULL,
  PRIMARY KEY (session_id, page_id)
);
CREATE INDEX idx_session_pages_page ON session_pages(page_id);
```

**API endpoints:**
- `POST /api/sessions` — record a session (with page list)
- `GET /api/sessions?page_id=X` — sessions that touched a page
- `GET /api/sessions?since=DATE` — recent sessions
- `GET /api/sessions/stats` — analytics (sessions per day, avg cost, common models)

**Migration:** Parse existing `.claude/sessions/*.yaml` files into rows. Update `crux/commands/agent-checklist.ts` to write session records to DB at session end.

**Consumers affected:**
- `apps/web/scripts/lib/session-log-parser.mjs` — replace with DB query
- `apps/web/src/app/internal/page-changes/` — get change history from DB
- `crux/validate/validate-session-logs.ts` — validate DB records instead of YAML

---

### 1.3 Auto-Update State

**Current state:** `data/auto-update/` contains run reports (YAML), seen-items map, fetch-times, watchlist, sources config.

**Problems:**
- Run history requires scanning all `runs/*.yaml` files
- Seen-items deduplication loads entire map on every run
- No efficient budget tracking across runs
- Dashboard (`/internal/auto-update-runs`) reads files from disk

**Proposed schema:**
```sql
CREATE TABLE auto_update_runs (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  trigger TEXT NOT NULL,         -- scheduled, manual
  budget_limit REAL,
  budget_spent REAL,
  sources_checked INTEGER,
  sources_failed INTEGER,
  items_fetched INTEGER,
  items_relevant INTEGER,
  pages_planned INTEGER,
  pages_updated INTEGER,
  pages_failed INTEGER,
  pages_skipped INTEGER,
  new_pages_created INTEGER DEFAULT 0,
  details_json JSONB,            -- full digest/plan for deep inspection
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE auto_update_results (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES auto_update_runs(id),
  page_id TEXT NOT NULL,
  status TEXT NOT NULL,          -- success, failed, skipped
  tier TEXT,                     -- polish, standard, deep
  duration_ms INTEGER,
  error_message TEXT,
  directions TEXT
);
CREATE INDEX idx_au_results_run ON auto_update_results(run_id);
CREATE INDEX idx_au_results_page ON auto_update_results(page_id);

CREATE TABLE auto_update_seen_items (
  item_id TEXT PRIMARY KEY,      -- normalized URL or content hash
  source_name TEXT,
  first_seen TIMESTAMPTZ DEFAULT now(),
  title TEXT,
  url TEXT
);
```

**API endpoints:**
- `POST /api/auto-update/runs` — record a run
- `POST /api/auto-update/results` — record page-level results
- `POST /api/auto-update/seen` — mark items as seen (batch)
- `GET /api/auto-update/seen?item_id=X` — check if seen
- `GET /api/auto-update/runs?since=DATE` — run history
- `GET /api/auto-update/runs/:id` — single run detail
- `GET /api/auto-update/stats` — budget over time, success rates, pages per run

**What stays in YAML:**
- `sources.yaml` — source configuration (rarely changes, benefits from git review)
- `watchlist.yaml` — page update targets (content decision, benefits from git review)

**Migration:** Parse existing `runs/*.yaml` and `state.yaml` into DB. Update `crux/auto-update/orchestrator.ts` to write results to DB.

---

### 1.4 Citation Accuracy (extend existing citation_quotes)

**Current state:** `data/citation-accuracy/pages/*.yaml` stores per-citation verification verdicts. The wiki-server *already* has `citation_quotes` with accuracy fields (`accuracy_verdict`, `accuracy_score`, `accuracy_issues`, etc.), but these aren't fully used yet.

**Problem:** Duplicate storage — accuracy data exists in both YAML files and partially in PG. The YAML files are the actual source of truth for the dashboard.

**Proposed change:** Make the existing `citation_quotes` table the single source of truth for accuracy data. Remove YAML-based citation accuracy storage.

**Additional schema (to capture the summary report):**
```sql
CREATE TABLE citation_accuracy_snapshots (
  id BIGSERIAL PRIMARY KEY,
  computed_at TIMESTAMPTZ NOT NULL,
  total_citations INTEGER,
  checked_citations INTEGER,
  accurate INTEGER,
  inaccurate INTEGER,
  unsupported INTEGER,
  minor_issues INTEGER,
  average_score REAL,
  domain_analysis_json JSONB,
  page_stats_json JSONB
);
```

**API endpoints:**
- Already exist: `/api/citations/quotes/mark-accuracy`, `/api/citations/accuracy-summary`
- Add: `POST /api/citations/accuracy-snapshot` — persist point-in-time summary
- Add: `GET /api/citations/accuracy-trend` — accuracy over time

**Migration:** Parse `data/citation-accuracy/pages/*.yaml` → upsert into `citation_quotes` accuracy fields. Update `crux/citations/check-accuracy.ts` to write directly to DB.

---

## Tier 2: Moderate Impact, Good Fit

### 2.1 Resources Index

**Current state:** `data/resources/*.yaml` — 10 files totaling **~30MB** (papers.yaml alone is 27MB). Contains URLs, titles, summaries, key points, publication metadata, cited_by references.

**Problems:**
- 27MB YAML file is painful for git (slow diffs, large clones)
- No search/filtering without loading entire file into memory
- Growing unboundedly as new papers are indexed
- Duplicate detection requires full scan

**Proposed schema:**
```sql
CREATE TABLE resources (
  id TEXT PRIMARY KEY,           -- UUID
  url TEXT NOT NULL,
  title TEXT,
  type TEXT,                     -- web, paper, report, etc.
  summary TEXT,
  review TEXT,
  key_points JSONB,
  publication_id TEXT,
  authors JSONB,
  published_date DATE,
  tags JSONB,
  fetched_at TIMESTAMPTZ,
  local_filename TEXT,
  content_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_resources_url ON resources(url);
CREATE INDEX idx_resources_pub ON resources(publication_id);
CREATE INDEX idx_resources_tags ON resources USING gin(tags);

CREATE TABLE resource_citations (
  resource_id TEXT REFERENCES resources(id),
  page_id TEXT NOT NULL,
  PRIMARY KEY (resource_id, page_id)
);
CREATE INDEX idx_resource_citations_page ON resource_citations(page_id);
```

**API endpoints:**
- `POST /api/resources/upsert` — add/update a resource
- `POST /api/resources/upsert-batch` — bulk import
- `GET /api/resources?url=X` — lookup by URL
- `GET /api/resources?page_id=X` — resources cited by a page
- `GET /api/resources/search?q=X` — full-text search over titles/summaries
- `GET /api/resources/stats` — count by type, domain distribution

**Impact:** Removes 30MB of YAML from git. Enables efficient resource lookup during content creation. Makes duplicate detection trivial (`SELECT * FROM resources WHERE url = ?`).

**Migration:** One-time import script. Update `crux/authoring/creator/source-fetching.ts` and build-data.mjs to read from DB.

---

### 2.2 Review Tracking

**Current state:** `data/reviews/` exists but is empty. The system is designed but not yet used.

**Opportunity:** Build this directly on the database from the start, avoiding the YAML-then-migrate pattern.

**Proposed schema:**
```sql
CREATE TABLE page_reviews (
  id BIGSERIAL PRIMARY KEY,
  page_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  scope TEXT NOT NULL,           -- full, citations, facts, partial
  date DATE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_reviews_page ON page_reviews(page_id);
CREATE INDEX idx_reviews_reviewer ON page_reviews(reviewer);
```

**API endpoints:**
- `POST /api/reviews` — record a review
- `GET /api/reviews?page_id=X` — review history for a page
- `GET /api/reviews/status` — all pages with review status (reviewed/unreviewed)
- `GET /api/reviews/stats` — coverage statistics

**Migration:** None needed (empty). Update `crux/lib/review-tracking.ts` to use DB.

---

### 2.3 Hallucination Risk Scores

**Current state:** Computed at build time in `build-data.mjs`, embedded per-page in `pages.json`.

**Problem:** No historical tracking. Can't answer "has risk gone up or down?" Can't query "top 20 high-risk pages" without loading all pages.

**Proposed schema:**
```sql
CREATE TABLE hallucination_risk (
  id BIGSERIAL PRIMARY KEY,
  page_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  level TEXT NOT NULL,            -- low, medium, high
  factors JSONB,                  -- array of risk factors
  integrity_issues JSONB,         -- content corruption signals
  computed_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_hr_page ON hallucination_risk(page_id);
CREATE INDEX idx_hr_score ON hallucination_risk(score DESC);
CREATE INDEX idx_hr_level ON hallucination_risk(level);
```

**API endpoints:**
- `POST /api/hallucination-risk/record` — store a computation
- `GET /api/hallucination-risk?level=high&limit=20` — top high-risk pages
- `GET /api/hallucination-risk/trend?page_id=X` — risk over time
- `GET /api/hallucination-risk/stats` — distribution summary

---

### 2.4 Fact Values (Temporal Read Layer)

**Current state:** `data/facts/*.yaml` contains 247+ canonical facts with `asOf` dates. Build-data.mjs normalizes and computes timeseries.

**Why DB:** Facts have natural temporal dimension (value as of date). DB enables efficient timeseries queries, staleness detection, and trend dashboards.

**Proposed approach:** YAML remains source of truth (facts are content, reviewed in PRs). DB is a read-optimized mirror synced during build.

**Proposed schema:**
```sql
CREATE TABLE facts (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,         -- hex slug
  label TEXT NOT NULL,
  value TEXT,                    -- display string
  numeric DOUBLE PRECISION,     -- numeric value for sorting/computation
  as_of DATE,
  note TEXT,
  source_url TEXT,
  source_resource_id TEXT,
  measure TEXT,
  unit TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entity_id, fact_id)
);
CREATE INDEX idx_facts_entity ON facts(entity_id);
CREATE INDEX idx_facts_measure ON facts(measure);
CREATE INDEX idx_facts_as_of ON facts(as_of);
```

**API endpoints:**
- `POST /api/facts/sync` — bulk upsert from YAML (run during build)
- `GET /api/facts?entity_id=X` — facts for an entity
- `GET /api/facts/timeseries?measure=X` — timeseries for a measure
- `GET /api/facts/stale?older_than=90d` — facts not updated recently

---

## Tier 3: Future / Nice-to-Have

### 3.1 Page Metrics History
Track quality, importance, word count, citation count changes over time. One row per page per build/measurement.

### 3.2 Related Graph
Store `relatedGraph.json` (1.75MB) in DB for incremental updates. When an entity changes, recompute only its edges instead of the full graph.

### 3.3 Backlinks
Store `backlinks.json` (776KB) in DB. Incremental updates when a page is edited.

### 3.4 Server-Side Search
Replace client-side MiniSearch with PostgreSQL full-text search (`tsvector` + `ts_rank`). Eliminates need to download 800KB of search index to the browser.

### 3.5 Entity Relationship Graph
The crux SQLite `entity_relations` table could be promoted to PostgreSQL for shared access.

---

## Architecture Changes

### New Server Route Structure
```
/api/
  ids/           (existing)
  citations/     (existing)
  edit-logs/     (new - Tier 1)
  sessions/      (new - Tier 1)
  auto-update/   (new - Tier 1)
  resources/     (new - Tier 2)
  reviews/       (new - Tier 2)
  hallucination-risk/  (new - Tier 2)
  facts/         (new - Tier 2)
  health         (existing)
```

### Shared Client Library
Create a shared `wiki-server-client` package that both the crux CLI and Next.js app can use:

```typescript
// packages/wiki-server-client/src/index.ts
export class WikiServerClient {
  constructor(private baseUrl: string, private apiKey?: string) {}

  // Edit logs
  async appendEditLog(entry: EditLogEntry): Promise<void>;
  async getEditLogs(pageId: string): Promise<EditLogEntry[]>;
  async getEditLogStats(): Promise<EditLogStats>;

  // Sessions
  async recordSession(session: SessionRecord): Promise<void>;
  async getSessionsForPage(pageId: string): Promise<SessionRecord[]>;

  // Auto-update
  async recordRun(run: AutoUpdateRun): Promise<void>;
  async checkSeen(itemIds: string[]): Promise<Set<string>>;
  async markSeen(items: SeenItem[]): Promise<void>;

  // Resources
  async upsertResource(resource: Resource): Promise<void>;
  async lookupByUrl(url: string): Promise<Resource | null>;

  // ... etc
}
```

### Build Pipeline Integration
`build-data.mjs` currently does heavy ETL. With DB backing:

1. **Read content from files** (entities, facts, pages — version-controlled)
2. **Read operational data from DB** (edit logs, sessions, citations, resources)
3. **Compute derived data** (backlinks, related graph, risk scores)
4. **Write derived data to DB** (for live dashboard queries)
5. **Generate database.json** (still needed for Next.js static builds, but smaller)

Over time, database.json can be trimmed as dashboards query the DB directly.

### Dashboard Migration
Internal dashboards (`/internal/*`) currently do `fs.readdirSync()` to scan YAML files. They can migrate to:

```typescript
// Before: Read files from disk
const runsDir = path.resolve(process.cwd(), "../../data/auto-update/runs");
const files = fs.readdirSync(runsDir);
const runs = files.map(f => loadYaml(fs.readFileSync(f)));

// After: Query the server
const client = new WikiServerClient(process.env.WIKI_SERVER_URL);
const runs = await client.getAutoUpdateRuns({ since: "2026-01-01" });
```

This makes dashboards work in deployed environments (where YAML files aren't on disk) and enables filtering/pagination server-side.

---

## Migration Strategy

### Phase 1: Edit Logs + Session Logs (lowest risk, highest value)
1. Add `edit_logs` and `sessions` + `session_pages` tables to wiki-server
2. Create migration script to import existing YAML files
3. Update crux `edit-log.ts` to dual-write (YAML + DB)
4. Update dashboards to read from DB
5. After validation period, deprecate YAML writes

### Phase 2: Auto-Update + Citation Accuracy
1. Add `auto_update_runs`, `auto_update_results`, `auto_update_seen_items` tables
2. Consolidate citation accuracy data into existing `citation_quotes` table
3. Import existing YAML data
4. Update crux auto-update orchestrator and citation commands

### Phase 3: Resources + Reviews
1. Add `resources` and `resource_citations` tables
2. Import 30MB of resources YAML
3. Remove `data/resources/*.yaml` from git (huge reduction in repo size)
4. Build reviews on DB from the start

### Phase 4: Derived Data + Optimization
1. Add `hallucination_risk`, `facts` tables
2. Update build-data.mjs to sync derived data to DB
3. Migrate remaining dashboards to DB-backed queries
4. Evaluate trimming database.json

---

## Impact Summary

| What | Current | After Migration | Benefit |
|---|---|---|---|
| Edit log queries | Scan 625 YAML files | Single SQL query | 100x faster cross-page queries |
| Session analytics | Regex parsing of YAML | Indexed DB queries | Reliable, filterable |
| Auto-update history | Load all run YAMLs | Paginated DB query | Scales indefinitely |
| Citation accuracy | YAML + partial PG | Single PG source | No duplication |
| Resource lookup | Load 30MB YAML | Indexed DB lookup | Removes 30MB from git |
| Dashboard loading | fs.readdirSync() per view | API call with filters | Works in deployed env |
| Hallucination risk | Recompute from scratch | Historical tracking | Trend analysis |
| Reviews | Empty YAML dir | DB-native | Clean start |

**Total git repo size reduction:** ~31MB (resources YAML removal alone)
**New DB tables:** 8-10 tables across Tiers 1-2
**New API endpoints:** ~25-30 endpoints
**Affected crux modules:** ~8 files (edit-log.ts, auto-update orchestrator, citation commands, review tracking, build-data.mjs, session logging, resource handling)
