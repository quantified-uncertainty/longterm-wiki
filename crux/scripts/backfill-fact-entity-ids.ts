/**
 * One-time backfill: populate entityId on source_check_verdicts rows for facts.
 *
 * All 1,911 fact verdicts were created without entityId because the creation
 * code in factbase-sourcing.ts did not pass result.entityId to the API.
 * That bug is now fixed. This script backfills existing rows.
 *
 * For each verdict with recordType='fact' and entityId IS NULL, we look up the
 * corresponding FactBase fact by its ID to get the subjectId (the entity stableId),
 * then re-POST the verdict with entityId set. The POST /verdicts endpoint is an
 * upsert keyed on (recordType, recordId, fieldName), so it safely updates in place.
 *
 * Usage:
 *   node --import tsx/esm crux/scripts/backfill-fact-entity-ids.ts            # dry-run (default)
 *   node --import tsx/esm crux/scripts/backfill-fact-entity-ids.ts --apply     # write to DB
 *   node --import tsx/esm crux/scripts/backfill-fact-entity-ids.ts --limit=100 # apply first 100
 *
 * Flags:
 *   --apply      Actually write updates (default: dry-run)
 *   --limit=N    Process at most N records
 *   --batch=N    Requests per second (default: 5)
 *
 * Safe to re-run: already-populated rows keep their entityId unchanged.
 */

import { config } from "dotenv";
import { join } from "node:path";

// Load .env from repo root
config({ path: join(import.meta.dirname, "../../.env") });

// ── Arg parsing ─────────────────────────────────────────────────────

const isDryRun = !process.argv.includes("--apply");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const batchArg = process.argv.find((a) => a.startsWith("--batch="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : undefined;
const batchSize = batchArg ? parseInt(batchArg.split("=")[1], 10) : 5;

// ── Config ───────────────────────────────────────────────────────────

const isProd = process.env.WIKI_SERVER_ENV === "prod";
const BASE_URL = isProd
  ? process.env.PROD_LONGTERMWIKI_SERVER_URL
  : process.env.LONGTERMWIKI_SERVER_URL ?? "http://localhost:4850";
const API_KEY = isProd
  ? process.env.PROD_LONGTERMWIKI_SERVER_API_KEY
  : process.env.LONGTERMWIKI_SERVER_API_KEY;

if (!BASE_URL) {
  console.error("ERROR: No wiki-server URL configured.");
  console.error("  Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod for production.");
  process.exit(1);
}

// ── API helpers ──────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

async function apiFetch(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const url = `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: buildHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) return { ok: false, error: `${res.status}: ${text.slice(0, 300)}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Types ────────────────────────────────────────────────────────────

interface VerdictRow {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number | null;
}

interface VerdictsListResult {
  verdicts: VerdictRow[];
  total: number;
}

// ── FactBase loader ──────────────────────────────────────────────────

// Lazy-load the FactBase graph (it's slow, ~2s) only when needed.
let factIndex: Map<string, string> | null = null;

async function buildFactIndex(): Promise<Map<string, string>> {
  if (factIndex) return factIndex;

  console.log("Loading FactBase graph (this takes ~2s)…");
  // Dynamic import to avoid loading at startup in dry-run where it's still useful
  const { loadGraphFull } = await import("../lib/factbase-loader.ts");
  const { graph } = await loadGraphFull();

  const index = new Map<string, string>();
  for (const entity of graph.getAllEntities()) {
    const facts = graph.getFacts(entity.id);
    for (const fact of facts) {
      // fact.subjectId is the entity stableId (10-char sid_ prefix value)
      index.set(fact.id, fact.subjectId);
    }
  }

  console.log(`Indexed ${index.size} facts across all entities.`);
  factIndex = index;
  return index;
}

// ── Fetch verdicts that need backfill ────────────────────────────────

async function fetchNullEntityVerdicts(): Promise<VerdictRow[]> {
  // Fetch all fact verdicts in pages of 200 and filter locally for entityId=null.
  // The list endpoint doesn't yet have an entity_id=null filter, so we page through.
  const PAGE = 200;
  const rows: VerdictRow[] = [];
  let offset = 0;
  let total = Infinity;

  while (rows.length < total) {
    const res = await apiFetch(
      "GET",
      `/api/source-checks/verdicts?record_type=fact&limit=${PAGE}&offset=${offset}`,
    );
    if (!res.ok) {
      console.error(`Failed to fetch verdicts: ${res.error}`);
      process.exit(1);
    }

    const page = res.data as VerdictsListResult;
    total = page.total;
    offset += page.verdicts.length;

    for (const v of page.verdicts) {
      if (v.entityId == null) {
        rows.push(v);
      }
    }

    if (page.verdicts.length === 0) break; // safety: no more pages

    process.stdout.write(`\r  Fetched ${offset}/${total} verdicts, found ${rows.length} with null entityId…`);
  }
  process.stdout.write("\n");

  return rows;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== backfill-fact-entity-ids ===`);
  console.log(`Mode: ${isDryRun ? "DRY RUN (pass --apply to write)" : "APPLY"}`);
  console.log(`Target: ${BASE_URL}`);
  console.log();

  // 1. Fetch all fact verdicts with null entityId
  console.log("Step 1: Fetching fact verdicts with null entityId…");
  let rows = await fetchNullEntityVerdicts();
  console.log(`Found ${rows.length} fact verdicts with entityId = null.`);

  if (rows.length === 0) {
    console.log("Nothing to backfill. All fact verdicts already have entityId set.");
    return;
  }

  if (limit && limit < rows.length) {
    console.log(`Applying --limit=${limit}: processing first ${limit} of ${rows.length}.`);
    rows = rows.slice(0, limit);
  }

  // 2. Build fact → subjectId index from FactBase
  console.log("\nStep 2: Building FactBase fact index…");
  const factToEntity = await buildFactIndex();

  // 3. Resolve each verdict's entityId
  let resolved = 0;
  let unresolved = 0;
  const updates: Array<{ row: VerdictRow; entityId: string }> = [];

  for (const row of rows) {
    const entityId = factToEntity.get(row.recordId);
    if (!entityId) {
      // Fact may have been deleted from FactBase YAML
      console.warn(`  SKIP ${row.recordId}: fact not found in FactBase (may have been deleted)`);
      unresolved++;
      continue;
    }
    updates.push({ row, entityId });
    resolved++;
  }

  console.log(`\nStep 3: Resolution summary`);
  console.log(`  Resolved:   ${resolved}`);
  console.log(`  Unresolved: ${unresolved} (facts not in FactBase — will be skipped)`);

  if (isDryRun) {
    console.log("\n[DRY RUN] Would send the following updates:");
    const preview = updates.slice(0, 20);
    for (const { row, entityId } of preview) {
      console.log(`  ${row.recordId}  →  entityId=${entityId}  (verdict=${row.verdict})`);
    }
    if (updates.length > 20) {
      console.log(`  … and ${updates.length - 20} more`);
    }
    console.log(`\nTotal updates that would be sent: ${updates.length}`);
    console.log("Re-run with --apply to write these to the database.");
    return;
  }

  // 4. Apply updates via POST /verdicts (upsert by recordType+recordId+fieldName)
  console.log(`\nStep 4: Applying ${updates.length} updates…`);
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < updates.length; i++) {
    const { row, entityId } = updates[i];

    const body = {
      recordType: row.recordType,
      recordId: row.recordId,
      fieldName: row.fieldName ?? undefined,
      entityId,
      verdict: row.verdict,
      confidence: row.confidence ?? undefined,
      reasoning: row.reasoning ?? undefined,
      sourcesChecked: row.sourcesChecked ?? undefined,
    };

    const res = await apiFetch("POST", "/api/source-checks/verdicts", body);

    if (res.ok) {
      success++;
    } else {
      failed++;
      errors.push(`${row.recordId}: ${res.error}`);
    }

    // Progress
    if ((i + 1) % 50 === 0 || i === updates.length - 1) {
      process.stdout.write(`\r  Progress: ${i + 1}/${updates.length} (${success} ok, ${failed} failed)`);
    }

    // Simple rate limiting: pause after every batchSize requests
    if ((i + 1) % batchSize === 0 && i < updates.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  process.stdout.write("\n");

  // 5. Report
  console.log(`\n=== Summary ===`);
  console.log(`  Updated:    ${success}`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Skipped:    ${unresolved}`);

  if (errors.length > 0) {
    console.log(`\nErrors (first 10):`);
    for (const e of errors.slice(0, 10)) {
      console.log(`  ${e}`);
    }
  }

  if (failed === 0) {
    console.log("\nBackfill complete.");
  } else {
    console.log(`\nCompleted with ${failed} failures. Re-run to retry failed rows (idempotent).`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
