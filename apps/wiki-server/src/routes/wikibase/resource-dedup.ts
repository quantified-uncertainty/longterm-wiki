/**
 * QUA-561 — One-shot resource dedup logic.
 *
 * Finds rows in the `resources` table whose URLs collapse to the same
 * canonical key under `normalizeUrl` (QUA-341). For each duplicate cluster,
 * selects a canonical row (most FK references → earliest created_at →
 * smallest id), rewrites every FK pointing at the cluster's non-canonical
 * rows, and deletes them. Each cluster is merged inside its own transaction.
 *
 * FK columns are discovered at runtime from information_schema. Columns that
 * participate in a PK/UNIQUE constraint (e.g. resource_papers.resource_id as
 * a PK, or resource_citations (resource_id, page_id)) are handled carefully:
 * cluster rows that would collide with canonical's existing rows after the
 * UPDATE are deleted first so the UPDATE cannot raise a unique violation.
 */

import type { Sql, CallableTransactionSql } from "../../db.js";
import { beginTransaction } from "../../db.js";
import { normalizeUrlForDedup } from "@longterm-wiki/url-utils";
import { logger } from "../../logger.js";
import { applyTruncation } from "../shared/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FkColumnInfo {
  tableName: string;
  columnName: string;
  /** Which column on `resources` this FK targets. QUA-549 Phase B has
   *  swapped most FKs from `id` to `stable_id`; the dedup flow tracks both
   *  forms (QUA-589) so per-FK rewrites use the right value type. */
  targetColumn: "id" | "stable_id";
  /** PK/UNIQUE constraints on this table that include columnName. otherCols
   *  is the set of columns in the constraint besides columnName. Empty
   *  otherCols means this column alone must be unique. */
  uniqueGroups: { otherCols: string[] }[];
}

export interface ResourceCandidate {
  id: string;
  url: string;
  createdAt: string;
  refCount: number;
}

export interface DedupCluster {
  normalizedUrl: string;
  canonical: ResourceCandidate;
  duplicates: ResourceCandidate[];
}

export interface DedupReport {
  totalResources: number;
  fkColumns: FkColumnInfo[];
  clusters: DedupCluster[];
  /** True when the resources scan hit RESOURCES_SCAN_CAP — clusters beyond
   *  the cap are invisible to this run. Raise the cap or switch to chunked
   *  scanning before running apply=true. */
  truncated: boolean;
}

// QUA-623: cap the full-table scan in buildReport(). resources is ~22k rows
// today (well below this cap); the cap exists to prevent silent HTTP 503s if
// the table grows. buildReport is an admin-only dedup tool — raising this
// requires both a config bump and a confirmation it still completes under
// the 30s statement_timeout.
export const RESOURCES_SCAN_CAP = 500_000;

/**
 * Thrown from `runDedup` when `apply=true` is called on a truncated scan.
 * HTTP handlers should catch this and translate to a 409 so CLI callers get
 * an actionable message instead of a generic 500.
 */
export class ScanTruncatedError extends Error {
  readonly scanCap: number;
  constructor(scanCap: number) {
    super(
      `runDedup refused: resources scan was truncated at ${scanCap} rows; raise RESOURCES_SCAN_CAP or implement chunked scanning before applying.`,
    );
    this.name = "ScanTruncatedError";
    this.scanCap = scanCap;
  }
}

export interface ClusterMergeResult {
  canonicalId: string;
  duplicateIds: string[];
  fkUpdates: Record<string, { moved: number; deletedOnConflict: number }>;
  resourcesDeleted: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Canonical dedup key for grouping resources. Delegates to
 *  `normalizeUrlForDedup` so cluster membership stays in sync with the
 *  shared QUA-341 normalization helper. */
export const dedupKey = normalizeUrlForDedup;

/**
 * Pick the canonical row from a cluster.
 *   1. highest refCount
 *   2. earliest createdAt (ISO string compare)
 *   3. smallest id (lexicographic)
 */
export function pickCanonical<
  T extends { refCount: number; createdAt: string; id: string },
>(rows: T[]): T {
  if (rows.length === 0) throw new Error("pickCanonical: empty cluster");
  return [...rows].sort((a, b) => {
    if (a.refCount !== b.refCount) return b.refCount - a.refCount;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/** Guard against SQL injection via dynamic identifiers. FK metadata comes
 *  from information_schema but defense-in-depth is cheap. */
export function validateIdent(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  }
}

function q(name: string): string {
  validateIdent(name);
  return `"${name}"`;
}

/** Dedupe FK metadata by (table, column, targetColumn). A column CAN be
 *  referenced by more than one FK constraint in Postgres; we keep this helper
 *  defensively even after QUA-569 reconciled the last known duplicate
 *  (page_citations.resource_id was the historical case — migration 0193
 *  dropped its duplicate pair). The targetColumn part of the key is defensive
 *  for the unusual case where a single (table, column) has FKs pointing at
 *  both resources.id and resources.stable_id simultaneously — keep both so
 *  the merge rewrites whichever values are actually stored. */
export function dedupeFkColumns(fks: FkColumnInfo[]): FkColumnInfo[] {
  const seen = new Map<string, FkColumnInfo>();
  for (const f of fks) {
    const key = `${f.tableName}.${f.columnName}:${f.targetColumn}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Discovery + report
// ---------------------------------------------------------------------------

export async function loadResourceFks(sql: Sql): Promise<FkColumnInfo[]> {
  // QUA-589: include both resources.id and resources.stable_id as valid FK
  // targets. QUA-549 Phase B has swapped most FKs from id → stable_id;
  // restricting discovery to id silently dropped migrated tables off the
  // dedup sweep (CASCADE still cleaned them on resource delete, but the
  // FK-rewrite-to-canonical path no longer fired).
  const fkRows = await sql<{
    table_name: string;
    column_name: string;
    target_column: string;
  }[]>`
    SELECT DISTINCT tc.table_name, kcu.column_name, ccu.column_name AS target_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'resources'
      AND ccu.column_name IN ('id', 'stable_id')
      AND tc.table_schema = 'public'
    ORDER BY tc.table_name, kcu.column_name, ccu.column_name
  `;
  if (fkRows.length === 0) return [];

  const tableNames = [...new Set(fkRows.map((f) => f.table_name))];
  const uniqueRows = await sql<{ table_name: string; columns: string[] }[]>`
    SELECT tc.table_name,
      array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      AND tc.table_schema = 'public'
      AND tc.table_name = ANY(${tableNames})
    GROUP BY tc.table_name, tc.constraint_name
  `;

  const uniqueByTable = new Map<string, { columns: string[] }[]>();
  for (const u of uniqueRows) {
    const list = uniqueByTable.get(u.table_name) ?? [];
    list.push({ columns: u.columns });
    uniqueByTable.set(u.table_name, list);
  }

  return fkRows.map((fk) => {
    const uniques = uniqueByTable.get(fk.table_name) ?? [];
    const uniqueGroups = uniques
      .filter((u) => u.columns.includes(fk.column_name))
      .map((u) => ({ otherCols: u.columns.filter((c) => c !== fk.column_name) }));
    if (fk.target_column !== "id" && fk.target_column !== "stable_id") {
      // Defensive: the SQL filter restricts to ('id', 'stable_id'), so this
      // branch is unreachable. Throw rather than silently mis-categorize a
      // future FK target we haven't taught mergeCluster how to translate.
      throw new Error(
        `loadResourceFks: unexpected FK target resources.${fk.target_column} ` +
          `on ${fk.table_name}.${fk.column_name}`,
      );
    }
    return {
      tableName: fk.table_name,
      columnName: fk.column_name,
      targetColumn: fk.target_column,
      uniqueGroups,
    };
  });
}

export async function buildReport(
  sql: Sql,
  opts?: { scanCap?: number },
): Promise<DedupReport> {
  const scanCap = opts?.scanCap ?? RESOURCES_SCAN_CAP;
  const fkColumns = await loadResourceFks(sql);
  const uniqueCols = dedupeFkColumns(fkColumns);

  // QUA-623: cap with a +1 sentinel so the caller can tell the scan was
  // partial. Dedup apply=true should refuse to run on a truncated report —
  // clusters past the cutoff would silently survive.
  const rows = await sql<{ id: string; url: string; created_at: string }[]>`
    SELECT id, url, created_at::text AS created_at FROM resources
    LIMIT ${scanCap + 1}
  `;
  const { items: scanned, truncated } = applyTruncation(rows, scanCap);

  type Row = { id: string; url: string; createdAt: string };
  const groups = new Map<string, Row[]>();
  for (const r of scanned) {
    const key = dedupKey(r.url);
    const list = groups.get(key);
    if (list) list.push({ id: r.id, url: r.url, createdAt: r.created_at });
    else groups.set(key, [{ id: r.id, url: r.url, createdAt: r.created_at }]);
  }

  const candidateIds = new Set<string>();
  for (const rs of groups.values()) {
    if (rs.length >= 2) for (const r of rs) candidateIds.add(r.id);
  }

  const refCounts = new Map<string, number>();
  if (candidateIds.size > 0) {
    const idsArr = [...candidateIds];

    // QUA-589: FKs may target either resources.id or resources.stable_id.
    // For stable_id-targeting FKs we have to translate the id-keyed
    // candidateIds into their stable_id values before querying, then
    // translate the matched FK values back to id when accumulating refCount
    // (the refCount map is keyed by resources.id throughout).
    const needsStable = uniqueCols.some((f) => f.targetColumn === "stable_id");
    const idToStable = new Map<string, string>();
    const stableToId = new Map<string, string>();
    if (needsStable) {
      const mapRows = await sql<{ id: string; stable_id: string | null }[]>`
        SELECT id, stable_id FROM resources WHERE id = ANY(${idsArr})
      `;
      for (const r of mapRows) {
        if (r.stable_id) {
          idToStable.set(r.id, r.stable_id);
          stableToId.set(r.stable_id, r.id);
        }
      }
    }

    for (const fk of uniqueCols) {
      const isStable = fk.targetColumn === "stable_id";
      const valueSet = isStable
        ? idsArr
            .map((id) => idToStable.get(id))
            .filter((v): v is string => v !== undefined)
        : idsArr;
      if (valueSet.length === 0) continue;

      const results = await sql.unsafe<{ id: string; c: number | string }[]>(
        `SELECT ${q(fk.columnName)} AS id, COUNT(*)::int AS c
         FROM ${q(fk.tableName)}
         WHERE ${q(fk.columnName)} = ANY($1::text[])
         GROUP BY ${q(fk.columnName)}`,
        [valueSet]
      );
      for (const row of results) {
        const resourceId = isStable ? stableToId.get(row.id) : row.id;
        if (!resourceId) continue;
        refCounts.set(
          resourceId,
          (refCounts.get(resourceId) ?? 0) + Number(row.c)
        );
      }
    }
  }

  const clusters: DedupCluster[] = [];
  for (const [key, rs] of groups) {
    if (rs.length < 2) continue;
    const candidates: ResourceCandidate[] = rs.map((r) => ({
      id: r.id,
      url: r.url,
      createdAt: r.createdAt,
      refCount: refCounts.get(r.id) ?? 0,
    }));
    const canonical = pickCanonical(candidates);
    const duplicates = candidates.filter((c) => c.id !== canonical.id);
    clusters.push({ normalizedUrl: key, canonical, duplicates });
  }

  clusters.sort((a, b) => {
    if (a.duplicates.length !== b.duplicates.length)
      return b.duplicates.length - a.duplicates.length;
    return a.normalizedUrl < b.normalizedUrl ? -1 : 1;
  });

  return { totalResources: scanned.length, fkColumns, clusters, truncated };
}

// ---------------------------------------------------------------------------
// Per-cluster merge
// ---------------------------------------------------------------------------

/**
 * Merge one cluster: rewrite FKs on the duplicates to point at canonical,
 * then delete the duplicates. Must run inside a transaction — the caller is
 * responsible for `sql.begin()` / `beginTransaction()`.
 *
 * Accepts CallableTransactionSql (from beginTransaction) for production use.
 * Tests may pass the root Sql client cast through this type since a
 * postgres.js root client is structurally compatible (tagged-template +
 * `.unsafe`) with the transaction interface at runtime.
 */
export async function mergeCluster(
  tx: CallableTransactionSql,
  canonicalId: string,
  duplicateIds: string[],
  fkColumns: FkColumnInfo[]
): Promise<ClusterMergeResult> {
  const fkUpdates: ClusterMergeResult["fkUpdates"] = {};
  if (duplicateIds.length === 0) {
    return { canonicalId, duplicateIds, fkUpdates, resourcesDeleted: 0 };
  }

  const uniqueCols = dedupeFkColumns(fkColumns);
  const allIds = [canonicalId, ...duplicateIds];

  // QUA-589: Phase B FKs target resources.stable_id, not resources.id.
  // Pre-resolve (id → stable_id) for the cluster so per-FK SQL can use the
  // right value type. Fail loudly if any clustered resource is missing a
  // stable_id — silently skipping a stable_id-targeting FK would leave
  // orphan child rows pointing at the about-to-be-deleted duplicate.
  const needsStable = uniqueCols.some((f) => f.targetColumn === "stable_id");
  const idToStable = new Map<string, string>();
  if (needsStable) {
    const mapRows = await tx<{ id: string; stable_id: string | null }[]>`
      SELECT id, stable_id FROM resources WHERE id = ANY(${allIds})
    `;
    for (const r of mapRows) {
      if (r.stable_id) idToStable.set(r.id, r.stable_id);
    }
    const missing = allIds.filter((id) => !idToStable.has(id));
    if (missing.length > 0) {
      throw new Error(
        `mergeCluster: ${missing.length} clustered resource(s) have NULL stable_id ` +
          `(${missing.join(", ")}); cannot rewrite stable_id-targeting FKs. ` +
          `Backfill resources.stable_id (see migration 0184_qua_536) before retrying.`,
      );
    }
  }

  for (const fk of uniqueCols) {
    const key = `${fk.tableName}.${fk.columnName}`;
    fkUpdates[key] = fkUpdates[key] ?? { moved: 0, deletedOnConflict: 0 };

    const isStable = fk.targetColumn === "stable_id";
    const canonValue = isStable ? idToStable.get(canonicalId)! : canonicalId;
    const allValues = isStable
      ? allIds.map((id) => idToStable.get(id)!)
      : allIds;
    const dupValues = isStable
      ? duplicateIds.map((id) => idToStable.get(id)!)
      : duplicateIds;

    // For each unique constraint involving this column, delete cluster rows
    // that would collide with canonical's existing rows post-UPDATE. Prefer
    // keeping canonical's row; tiebreak by ctid (physical order).
    for (const group of fk.uniqueGroups) {
      const partition =
        group.otherCols.length > 0
          ? `PARTITION BY ${group.otherCols.map(q).join(", ")}`
          : "";
      const deleteSql = `
        WITH ranked AS (
          SELECT ctid,
            ROW_NUMBER() OVER (
              ${partition}
              ORDER BY (${q(fk.columnName)} = $1) DESC, ctid ASC
            ) AS rn
          FROM ${q(fk.tableName)}
          WHERE ${q(fk.columnName)} = ANY($2::text[])
        )
        DELETE FROM ${q(fk.tableName)} t
        USING ranked r
        WHERE t.ctid = r.ctid AND r.rn > 1
        RETURNING 1
      `;
      const deleted = await tx.unsafe<unknown[]>(deleteSql, [
        canonValue,
        allValues,
      ]);
      fkUpdates[key].deletedOnConflict += deleted.length;
    }

    const updateSql = `
      UPDATE ${q(fk.tableName)}
      SET ${q(fk.columnName)} = $1
      WHERE ${q(fk.columnName)} = ANY($2::text[])
      RETURNING 1
    `;
    const moved = await tx.unsafe<unknown[]>(updateSql, [
      canonValue,
      dupValues,
    ]);
    fkUpdates[key].moved += moved.length;
  }

  // Remove duplicate `things` rows (dual-write mirror from the upsert path).
  // The `things` table has a unique (source_table, source_id) index so each
  // resource has at most one `things` row. No FK from things.source_id to
  // resources.id — cleanup is by logical (source_table, source_id) match.
  await tx`
    DELETE FROM things
    WHERE source_table = 'resources' AND source_id = ANY(${duplicateIds})
  `;

  const deletedResources = await tx<{ id: string }[]>`
    DELETE FROM resources WHERE id = ANY(${duplicateIds}) RETURNING id
  `;

  return {
    canonicalId,
    duplicateIds,
    fkUpdates,
    resourcesDeleted: deletedResources.length,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunDedupResult {
  apply: boolean;
  report: DedupReport;
  merges: ClusterMergeResult[];
  errors: { canonicalId: string; duplicateIds: string[]; message: string }[];
}

/**
 * Scan, pick canonicals, and (optionally) apply merges.
 */
export async function runDedup(
  sql: Sql,
  apply: boolean,
  opts?: { scanCap?: number },
): Promise<RunDedupResult> {
  const scanCap = opts?.scanCap ?? RESOURCES_SCAN_CAP;
  const report = await buildReport(sql, { scanCap });
  const merges: ClusterMergeResult[] = [];
  const errors: RunDedupResult["errors"] = [];

  if (!apply) return { apply, report, merges, errors };

  // Refuse apply=true when the scan was truncated. Clusters past the cutoff
  // would silently survive — raise RESOURCES_SCAN_CAP or chunk the scan.
  if (report.truncated) {
    throw new ScanTruncatedError(scanCap);
  }

  const rowsToDelete = report.clusters.reduce(
    (acc, c) => acc + c.duplicates.length,
    0
  );
  logger.warn(
    {
      totalResources: report.totalResources,
      clusters: report.clusters.length,
      rowsToDelete,
      fkColumns: report.fkColumns.length,
    },
    "runDedup applying — about to delete resource rows and rewrite FKs"
  );

  for (const cluster of report.clusters) {
    const dupIds = cluster.duplicates.map((d) => d.id);
    try {
      const result = await beginTransaction((tx) =>
        mergeCluster(tx, cluster.canonical.id, dupIds, report.fkColumns)
      );
      merges.push(result);
    } catch (err) {
      errors.push({
        canonicalId: cluster.canonical.id,
        duplicateIds: dupIds,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.warn(
    {
      merged: merges.length,
      errors: errors.length,
      resourcesDeleted: merges.reduce((a, m) => a + m.resourcesDeleted, 0),
    },
    "runDedup applied"
  );

  return { apply, report, merges, errors };
}
