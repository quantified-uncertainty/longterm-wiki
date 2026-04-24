# Audit Log System — Subsystem Map

Universal PG audit log (QUA-442) + the older `tablebase_audit_log`. Read this
**before** proposing a new audit-related change, adding an audit write, or
writing a background job that mutates rows — both layers are already wired
and the most common mistake is to bypass them.

## Two layers, different purposes

| Layer | Table | Populated by | Purpose |
|---|---|---|---|
| **Universal (QUA-442)** | `full_audit_log` | `audit_trigger_fn()` PL/pgSQL trigger on every allow-listed table | Comprehensive capture of every INSERT/UPDATE/DELETE, forever. Raw JSONB, session attribution. |
| **Rich (legacy)** | `tablebase_audit_log` | Explicit `logAuditEntries(tx, entries)` calls (sync-factory + a few routes) | Richer per-record attribution: source URL, verdict, evidence. Only populated for sync-factory writes. |

**They complement, not replace.** The universal log is the floor (anything
that writes to PG is captured). The rich log is the ceiling (application-
layer metadata the trigger can't see).

## How attribution works end-to-end

1. **Crux client** sets `process.env.CRUX_COMMAND = '<domain> <command>'` at
   startup (`crux.mjs::main()`), and calls `primeAuditSessionId()` which
   looks up the current agent-checklist session via
   `getAgentSessionByBranch(currentBranch())` once and caches the result.
2. **Crux HTTP client** (`crux/lib/wiki-server/client.ts::buildHeaders()`)
   stamps `X-Agent-Session-Id` and `X-Agent-Tool` on every wiki-server
   request when the values are known.
3. **Wiki-server middleware** (`apps/wiki-server/src/middleware/audit-context.ts`)
   reads those two headers on every `/api/*` request and stashes them on
   `c.set('auditContext', ...)`.
4. **`applyAuditContext(tx, c)`** is called at the top of every Drizzle
   transaction in a route that writes data. It runs
   `SELECT set_config('app.agent_session_id', ..., true)` and
   `SELECT set_config('app.agent_tool', ..., true)` — both scoped to the
   transaction (`is_local = true`), so values reset on COMMIT/ROLLBACK.
5. **PG trigger** (`audit_trigger_fn`) fires after every INSERT/UPDATE/DELETE
   and reads those GUCs via `current_setting('app.agent_session_id', true)`,
   writing the attribution alongside `to_jsonb(OLD)` / `to_jsonb(NEW)`
   into `full_audit_log`.

Where the chain is most commonly broken: step 4. **Every new hand-rolled
transaction must call `applyAuditContext(tx, c)`**. The sync-factory does
this automatically; non-factory routes (entities, things, data-sources,
bluesky, ids, and anything outside `tablebase/`) need an explicit call.

## Allow-list — which tables get the trigger

Initial v1 allow-list lives in migration
`0204_qua_442_audit_log_universal_trigger.sql` and covers the TableBase
domain tables plus `entities` and `facts`. Excluded for v1:

- High-volume time-series: `*_snapshots`, `secondary_market_prices`
- System/pipeline state: `agent_sessions`, `active_agents`, `jobs`,
  `groundskeeper_runs`, `service_health_incidents`, `operations_log`
- Audit tables themselves: `full_audit_log`, `tablebase_audit_log`
- Derived/cache tables: `things`, `wikibase_page_similarity`,
  `wikibase_page_assessments`, `qa_page_checks`
- Claims pipeline (already has its own attribution): `claims`, `claim_sources`,
  `claim_page_references`, `proposed_claims`, `claim_record_links`,
  `statement_citations`, `statement_page_references`
- `edit_logs`, `sessions`, `session_pages` (separate audit)
- Scan output, enrichment runs

**Expanding**: a follow-up migration that calls `CALL apply_audit_trigger('<table>')`
for any non-listed table. The helper is idempotent.

**Removing**: `CALL remove_audit_trigger('<table>')`.

## `app.audit_skip` escape hatch

For bulk migrations that would flood the audit log with millions of rows,
set `app.audit_skip = 'true'` at the top of the transaction:

```sql
SET LOCAL app.audit_skip = 'true';
UPDATE big_table SET ... WHERE ...;
```

Values accepted: `'true'`, `'on'`, `'1'`. Anything else (including unset) is
treated as "don't skip."

**When to use it**: planned bulk rewrites where the migration's git history
IS the audit trail (e.g. Phase 4b-B `things` denormalization under QUA-408).

**When NOT to use it**: anything that writes unplanned state — bug fixes,
content edits, job workers. The trigger overhead is trivial (~5-10% per row)
and the audit trail is valuable.

## Reading the audit log

```bash
crux audit recent                                  # 50 most recent across all tables
crux audit recent --table=personnel --limit=200    # filter by table
crux audit recent --session=12345                  # all writes from one session
crux audit recent --txn=98765                      # all rows in one transaction
crux audit recent --since=2026-04-20T00:00:00Z --json
```

API: `GET /api/audit-log/recent?table=&session=&txn=&since=&limit=` returns
`{ entries: AuditEntry[] }` with `oldRow` + `newRow` as JSONB, plus
`sessionId`, `tool`, `txnId`, `changedAt`.

## Writing directly to `tablebase_audit_log` (the rich layer)

`logAuditEntries(tx, entries)` from
`apps/wiki-server/src/routes/tablebase/audit-log.ts`. Call **inside a
transaction** with pre-computed before/after state. Fields:

- `recordType`, `recordId` (required)
- `operation: 'insert' | 'update' | 'delete'` (required)
- `oldData`, `newData` (newData required)
- `sourceUrl`, `verdict`, `evidence` — richer than the trigger can provide
- `agentSessionId` — **auto-filled from `current_setting('app.agent_session_id')`
  when the caller doesn't pass one**, so all 4 existing callers pick up
  session attribution for free once the middleware is wired.

The sync-factory wires `auditRecordType` to call `logAuditEntries` for
each upsert chunk. Routes NOT using the factory must call it explicitly.

## Key files

| File | Purpose |
|------|---------|
| `apps/wiki-server/drizzle/helpers/audit_log_trigger.sql` | Source-of-truth SQL for `audit_trigger_fn()`, `apply_audit_trigger`, `remove_audit_trigger` |
| `apps/wiki-server/drizzle/0204_qua_442_audit_log_universal_trigger.sql` | Install + attach to allow-list |
| `apps/wiki-server/src/middleware/audit-context.ts` | Hono middleware + `applyAuditContext` helper |
| `apps/wiki-server/src/routes/operational/audit-log.ts` | `GET /api/audit-log/recent` |
| `apps/wiki-server/src/routes/tablebase/audit-log.ts` | `logAuditEntries()` for the rich layer |
| `apps/wiki-server/src/routes/tablebase/sync-factory.ts` | Calls `applyAuditContext(tx, c)` at tx start + `logAuditEntries` for opted-in routes |
| `crux/lib/wiki-server/audit-context.ts` | Client-side session-id cache + tool name |
| `crux/lib/wiki-server/client.ts::buildHeaders` | Stamps `X-Agent-Session-Id` / `X-Agent-Tool` |
| `crux/commands/audit.ts` | `crux audit recent` CLI |

## Common mistakes to avoid

1. **Hand-rolled transaction without `applyAuditContext(tx, c)`**. The row
   is still captured by the trigger, but `session_id` / `tool` are NULL.
   Add a one-line call at the top of the transaction callback.
2. **Calling `logAuditEntries(db, ...)` outside a transaction**. The GUC
   fallback for `agentSessionId` reads `current_setting(...)` which is
   only meaningful inside the transaction that set it. Always pass the `tx`.
3. **Adding a new domain table without extending the allow-list**. The
   trigger doesn't auto-attach to new tables. After the Drizzle migration
   that creates the table, add `CALL apply_audit_trigger('<new_table>')`
   in the same migration (or a follow-up).
4. **Using `app.audit_skip` as a general bypass**. It's only for bulk
   migrations; using it in application code silently loses history.
