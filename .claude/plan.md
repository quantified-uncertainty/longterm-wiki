# Plan: Scoped API Keys for Wiki-Server Environment Isolation

## Goal
Replace the single `LONGTERMWIKI_SERVER_API_KEY` with two scoped keys:
- **Project key** (`LONGTERMWIKI_PROJECT_KEY`) — all environments, grants access to append-only coordination endpoints (IDs, sessions, edit logs, jobs, agent sessions, auto-update tracking)
- **Content key** (`LONGTERMWIKI_CONTENT_KEY`) — production CI only, grants access to destructive content endpoints (page/entity/fact sync, claims, citations, resources, links, summaries, risk snapshots, artifacts)

Both keys authenticate against the same server URL. The old `LONGTERMWIKI_SERVER_API_KEY` continues to work as a "superkey" during migration.

## Route Classification

### Project scope (append-only / idempotent)
- `/api/ids/*` — ID allocation
- `/api/sessions/*` — session logs
- `/api/edit-logs/*` — edit history
- `/api/jobs/*` — job queue / agent coordination
- `/api/agent-sessions/*` — agent session tracking
- `/api/auto-update-runs` — auto-update run records
- `/api/auto-update-news/*` — auto-update news items

### Content scope (destructive upserts)
- `/api/pages/*` — page sync + delete
- `/api/entities/*` — entity sync
- `/api/facts/*` — fact sync
- `/api/claims/*` — claims insert/clear
- `/api/citations/*` — citation quotes, accuracy, content
- `/api/resources/*` — resource upsert
- `/api/links/*` — page link sync
- `/api/summaries/*` — summary upsert
- `/api/hallucination-risk/*` — risk snapshots
- `/api/artifacts` — improvement run artifacts

### Read-only (either key works)
All GET endpoints across all routes.

---

## Implementation Steps

### Step 1: Server-side scoped auth middleware
**File:** `apps/wiki-server/src/auth.ts` (new)

Create a scoped auth system:
- Parse env vars: `LONGTERMWIKI_SERVER_API_KEY` (legacy superkey), `LONGTERMWIKI_PROJECT_KEY`, `LONGTERMWIKI_CONTENT_KEY`
- Export middleware factories: `requireScope("project")`, `requireScope("content")`
- A request is authorized if its Bearer token matches:
  - The legacy superkey (grants all scopes), OR
  - The project key (grants project scope), OR
  - The content key (grants content scope)
- GET requests are authorized by ANY valid key (project or content)
- POST/PUT/PATCH/DELETE requests check the route's required scope

**File:** `apps/wiki-server/src/app.ts` (modify)

Replace the current single `bearerAuth` middleware with the scoped system:
```typescript
// Before: single key for everything
app.use("/api/*", bearerAuth({ token: apiKey }));

// After: scoped middleware per route group
app.use("/api/*", validateAnyKey());  // All routes require some valid key

// Content routes additionally require content scope
app.use("/api/pages/*", requireWriteScope("content"));
app.use("/api/entities/*", requireWriteScope("content"));
app.use("/api/facts/*", requireWriteScope("content"));
app.use("/api/claims/*", requireWriteScope("content"));
app.use("/api/citations/*", requireWriteScope("content"));
app.use("/api/resources/*", requireWriteScope("content"));
app.use("/api/links/*", requireWriteScope("content"));
app.use("/api/summaries/*", requireWriteScope("content"));
app.use("/api/hallucination-risk/*", requireWriteScope("content"));
app.use("/api/artifacts/*", requireWriteScope("content"));
```

The `requireWriteScope("content")` middleware only blocks non-GET requests. GETs pass through (reads are allowed for all scopes).

### Step 2: Add branch/commit audit columns
**File:** `apps/wiki-server/drizzle/0025_add_sync_audit_columns.sql` (new migration)

```sql
ALTER TABLE wiki_pages ADD COLUMN synced_from_branch TEXT;
ALTER TABLE wiki_pages ADD COLUMN synced_from_commit TEXT;
```

**File:** `apps/wiki-server/src/schema.ts` (modify)
Add the two columns to the `wikiPages` table definition.

**File:** `apps/wiki-server/src/routes/pages.ts` (modify)
Accept `syncedFromBranch` and `syncedFromCommit` in the sync request body, store them on upsert.

### Step 3: Update crux client to support scoped keys
**File:** `crux/lib/wiki-server/client.ts` (modify)

The client currently reads `LONGTERMWIKI_SERVER_API_KEY`. Update to:
- For project-scope calls (IDs, sessions, edit logs, jobs): use `LONGTERMWIKI_PROJECT_KEY` with fallback to `LONGTERMWIKI_SERVER_API_KEY`
- For content-scope calls (page sync, entity sync, etc.): use `LONGTERMWIKI_CONTENT_KEY` with fallback to `LONGTERMWIKI_SERVER_API_KEY`

Add a `scope` parameter to the internal fetch helper:
```typescript
function getApiKey(scope: "project" | "content"): string | undefined {
  if (scope === "project") {
    return process.env.LONGTERMWIKI_PROJECT_KEY
      || process.env.LONGTERMWIKI_SERVER_API_KEY;
  }
  return process.env.LONGTERMWIKI_CONTENT_KEY
    || process.env.LONGTERMWIKI_SERVER_API_KEY;
}
```

**File:** `apps/web/scripts/lib/id-client.mjs` (modify)
Same pattern: prefer `LONGTERMWIKI_PROJECT_KEY`, fall back to `LONGTERMWIKI_SERVER_API_KEY`.

### Step 4: Update crux sync commands to pass audit metadata
**File:** `crux/wiki-server/sync-pages.ts` (modify)

Before syncing, detect branch and commit:
```typescript
const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
const commit = execSync("git rev-parse --short HEAD").toString().trim();
```

Pass these in the sync request body alongside the pages array.

Similarly update `sync-entities.ts`, `sync-facts.ts` if they have the same sync pattern.

### Step 5: Update Next.js frontend
**File:** `apps/web/src/lib/wiki-server.ts` (modify)

The frontend only makes GET requests (reads). It can use either key. Update `getWikiServerConfig()`:
```typescript
const apiKey = process.env.LONGTERMWIKI_PROJECT_KEY
  || process.env.LONGTERMWIKI_CONTENT_KEY
  || process.env.LONGTERMWIKI_SERVER_API_KEY;
```

### Step 6: Update CI workflows
**File:** `.github/workflows/ci.yml` (modify)

- `build-and-test` job: pass `LONGTERMWIKI_PROJECT_KEY` (for ID allocation during build-data)
- `sync-content` job: pass `LONGTERMWIKI_CONTENT_KEY` (for page/entity/fact sync)
- Both jobs: stop passing `LONGTERMWIKI_SERVER_API_KEY` once migration is complete

**Files:** Other workflows that use the server:
- `.github/workflows/auto-update.yml` — needs both keys (runs sync + logs sessions)
- `.github/workflows/job-worker.yml` — needs project key (jobs) + content key (if it syncs content)
- `.github/workflows/scheduled-maintenance.yml` — needs project key
- `.github/workflows/wiki-server-docker.yml` — smoke test needs legacy superkey or both

### Step 7: Update GitHub secrets
Add to GitHub repo secrets:
- `LONGTERMWIKI_PROJECT_KEY` — new project-scope key
- `LONGTERMWIKI_CONTENT_KEY` — new content-scope key
- Keep `LONGTERMWIKI_SERVER_API_KEY` as the legacy superkey during migration

Add to Vercel project env vars:
- `LONGTERMWIKI_PROJECT_KEY` — for preview + production builds (read access)
- Do NOT add `LONGTERMWIKI_CONTENT_KEY` to Vercel (previews should not sync content)

### Step 8: Update local dev setup
**File:** `scripts/setup.sh` (modify)

Don't configure `LONGTERMWIKI_SERVER_URL` or content key by default. Add guidance:
```
# For most dev work, no server URL needed (uses local database.json).
# To allocate new entity IDs, set:
#   LONGTERMWIKI_SERVER_URL=https://wiki-server.k8s.quantifieduncertainty.org
#   LONGTERMWIKI_PROJECT_KEY=<ask a maintainer>
# Content sync key is restricted to CI — local devs cannot sync content to production.
```

### Step 9: Health endpoint for key validation
**File:** `apps/wiki-server/src/routes/health.ts` (modify)

Add an optional `/health/auth` endpoint (requires a key) that returns which scopes the presented key has:
```json
{ "scopes": ["project"], "key_type": "project" }
```
This helps debug "why can't I sync?" questions.

---

## Migration Strategy

1. **Deploy server with scoped auth** (Step 1) — the legacy superkey still works, so nothing breaks
2. **Generate new scoped keys** — create two new random tokens, add to server env
3. **Update GitHub secrets** (Step 7) — add new keys alongside old one
4. **Update CI workflows** (Step 6) — switch to new keys one workflow at a time
5. **Update crux client** (Step 3) — with fallback to old key, so local devs aren't broken
6. **Announce** — tell contributors to update their `.env` with the project key (or remove server URL for local-only mode)
7. **Remove legacy key** — once all callers are migrated, remove `LONGTERMWIKI_SERVER_API_KEY` from server env

The fallback chain (`LONGTERMWIKI_PROJECT_KEY` → `LONGTERMWIKI_SERVER_API_KEY`) means this can be rolled out incrementally without any coordination deadline.

---

## Testing

- Unit test the scoped auth middleware: project key can call `/api/ids/allocate` but not `/api/pages/sync`
- Unit test the scoped auth middleware: content key can call `/api/pages/sync` but not `/api/ids/allocate` (actually content key should probably NOT be able to allocate IDs — it should only do content. But this is debatable.)
- Unit test: legacy superkey can call everything
- Unit test: GET requests work with any valid key
- Integration test: smoke test with each key type
- CI test: verify sync-content job uses content key and succeeds
- CI test: verify build-data job uses project key (for ID allocation) and succeeds

## Files Changed (estimated)

| File | Change type |
|---|---|
| `apps/wiki-server/src/auth.ts` | **New** — scoped auth middleware |
| `apps/wiki-server/src/app.ts` | Modify — replace single bearerAuth with scoped middleware |
| `apps/wiki-server/src/schema.ts` | Modify — add audit columns |
| `apps/wiki-server/src/routes/pages.ts` | Modify — accept/store audit metadata |
| `apps/wiki-server/src/routes/health.ts` | Modify — add `/health/auth` endpoint |
| `apps/wiki-server/drizzle/0025_add_sync_audit_columns.sql` | **New** — migration |
| `crux/lib/wiki-server/client.ts` | Modify — scope-aware key selection |
| `apps/web/scripts/lib/id-client.mjs` | Modify — prefer project key |
| `apps/web/src/lib/wiki-server.ts` | Modify — key fallback chain |
| `crux/wiki-server/sync-pages.ts` | Modify — pass branch/commit |
| `.github/workflows/ci.yml` | Modify — use scoped keys |
| `.github/workflows/auto-update.yml` | Modify — use scoped keys |
| `.github/workflows/job-worker.yml` | Modify — use scoped keys |
| `.github/workflows/wiki-server-docker.yml` | Modify — smoke test with scoped keys |
| `scripts/setup.sh` | Modify — local dev guidance |
