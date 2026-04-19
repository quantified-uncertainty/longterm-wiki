/**
 * QUA-608: Audit all Phase B resources.* FK tables for format orphans.
 *
 * Background — the QUA-549 Phase B migration plan swapped 17 FK tables from
 * referencing resources.id (legacy hex16) to resources.stable_id (canonical
 * sid_<10>). Migration 0186 (RCV pilot) halted at deploy time because the
 * postgres-default *_fkey constraint survived the Drizzle-named *_fk drop;
 * the Step 2 UPDATE tried to write a sid_ value into a column whose surviving
 * FK still pointed at resources.id. Fixed in PR #4489.
 *
 * The ticket body hypothesized a separate concern: that a sid_ value might
 * have been written to resource_content_versions.resource_id BEFORE the
 * migration ran, via the /content/upsert dual-write path. Investigation on
 * 2026-04-19 showed this did not happen in prod — all 52 sid_-formatted
 * RCV rows came from the citation_content backfill (migration 0159) whose
 * source column was hex16-only, and the 0186 UPDATE rewrote them in place.
 *
 * This script lets you re-verify that claim on demand, and extends it to every
 * Phase B FK table. It reports the format distribution of `resource_id` in
 * each table plus any rows that don't resolve against resources.stable_id.
 *
 * Usage:
 *   DATABASE_URL="$PRODUCTION_DB_URL" npx tsx scripts/audit-resources-fk-format.ts
 *   # Or from the workspace root with .env loaded:
 *   set -a; . ./.env; set +a
 *   DATABASE_URL="$PRODUCTION_DB_URL" npx tsx apps/wiki-server/scripts/audit-resources-fk-format.ts
 *
 * Exit codes:
 *   0 — clean audit (every non-null resource_id is sid_-formatted and resolves)
 *   1 — format orphan(s) or non-sid_ row(s) found
 *   2 — unexpected error (bad DATABASE_URL, DB unreachable, missing table, etc.)
 */

import postgres from "postgres";

// Phase B FK tables (all reference resources.stable_id after migrations 0186-0197).
// Derived from the Phase B migration files under apps/wiki-server/drizzle/.
const PHASE_B_TABLES = [
  "resource_content_versions", // 0186
  "publications", // 0187
  "resource_policy_docs", // 0187
  "resource_tabular_sources", // 0188
  "source_snapshots", // 0188
  "entity_resources", // 0189
  "source_check_evidence", // 0191
  "bluesky_posts", // 0192
  "page_citations", // 0193
  "citation_quotes", // 0194
  "resource_papers", // 0197
] as const;

interface TableStats {
  table: string;
  total: number;
  nonNull: number;
  sidFormat: number;
  nonSidFormat: number;
  sidOrphans: number;
  nonSidOrphans: number;
  orphanSamples: string[];
  error?: string;
}

async function auditTable(sql: postgres.Sql, table: string): Promise<TableStats> {
  // LIKE 'sid_%' ESCAPE '\': explicit escape char so the underscore stays literal
  // regardless of session-level standard_conforming_strings / backslash_quote settings.
  const rows = await sql<
    Array<{
      total: string;
      non_null: string;
      sid_format: string;
      non_sid_format: string;
      sid_orphans: string;
      non_sid_orphans: string;
    }>
  >`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE resource_id IS NOT NULL)::text AS non_null,
      COUNT(*) FILTER (WHERE resource_id LIKE 'sid\_%' ESCAPE '\')::text AS sid_format,
      COUNT(*) FILTER (WHERE resource_id IS NOT NULL AND resource_id NOT LIKE 'sid\_%' ESCAPE '\')::text AS non_sid_format,
      COUNT(*) FILTER (
        WHERE resource_id LIKE 'sid\_%' ESCAPE '\'
          AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = ${sql(table)}.resource_id)
      )::text AS sid_orphans,
      COUNT(*) FILTER (
        WHERE resource_id IS NOT NULL
          AND resource_id NOT LIKE 'sid\_%' ESCAPE '\'
          AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = ${sql(table)}.resource_id)
      )::text AS non_sid_orphans
    FROM ${sql(table)}
  `;

  const sample = await sql<Array<{ resource_id: string }>>`
    SELECT DISTINCT resource_id
    FROM ${sql(table)}
    WHERE resource_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = ${sql(table)}.resource_id)
    LIMIT 5
  `;

  const r = rows[0];
  return {
    table,
    total: Number(r.total),
    nonNull: Number(r.non_null),
    sidFormat: Number(r.sid_format),
    nonSidFormat: Number(r.non_sid_format),
    sidOrphans: Number(r.sid_orphans),
    nonSidOrphans: Number(r.non_sid_orphans),
    orphanSamples: sample.map((s) => s.resource_id),
  };
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL must be set (pass --PRODUCTION_DB_URL explicitly to avoid ambiguity).");
    console.error("Example: DATABASE_URL=\"$PRODUCTION_DB_URL\" npx tsx apps/wiki-server/scripts/audit-resources-fk-format.ts");
    return 2;
  }

  const sql = postgres(url, { max: 3, idle_timeout: 30 });

  try {
    console.log(`Auditing ${PHASE_B_TABLES.length} Phase B FK tables for resource_id format orphans...\n`);
    console.log(
      "table                        | total    | non-null | sid_  | non-sid | sid-orph | non-sid-orph"
    );
    console.log(
      "-----------------------------+----------+----------+-------+---------+----------+-------------"
    );

    const results: TableStats[] = [];
    for (const table of PHASE_B_TABLES) {
      try {
        const stats = await auditTable(sql, table);
        results.push(stats);
        console.log(
          `${table.padEnd(28)} | ${String(stats.total).padStart(8)} | ${String(stats.nonNull).padStart(8)} | ${String(stats.sidFormat).padStart(5)} | ${String(stats.nonSidFormat).padStart(7)} | ${String(stats.sidOrphans).padStart(8)} | ${String(stats.nonSidOrphans).padStart(12)}`
        );
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const msg = rawMsg.trim() || `${err instanceof Error ? err.constructor.name : typeof err} (no message)`;
        results.push({
          table,
          total: 0,
          nonNull: 0,
          sidFormat: 0,
          nonSidFormat: 0,
          sidOrphans: 0,
          nonSidOrphans: 0,
          orphanSamples: [],
          error: msg,
        });
        console.log(`${table.padEnd(28)} | ERROR: ${msg}`);
      }
    }

    const errored = results.filter((r) => r.error !== undefined);
    const totalOrphans = results.reduce((sum, r) => sum + r.sidOrphans + r.nonSidOrphans, 0);
    const nonSidFormat = results.reduce((sum, r) => sum + r.nonSidFormat, 0);

    console.log("");
    if (errored.length > 0) {
      console.log(`✗ ${errored.length} table(s) failed to audit (see errors above).`);
      return 2;
    }
    if (totalOrphans === 0 && nonSidFormat === 0) {
      console.log("✓ Clean: every non-null resource_id across all Phase B tables is sid_-formatted and resolves against resources.stable_id.");
      return 0;
    }

    if (nonSidFormat > 0) {
      console.log(`✗ ${nonSidFormat} row(s) have non-sid_ format resource_id across Phase B tables:`);
      for (const r of results.filter((x) => x.nonSidFormat > 0)) {
        console.log(`  - ${r.table}: ${r.nonSidFormat} non-sid rows`);
      }
    }

    if (totalOrphans > 0) {
      console.log(`✗ ${totalOrphans} orphan(s) (resource_id with no matching resources.stable_id):`);
      for (const r of results.filter((x) => x.sidOrphans + x.nonSidOrphans > 0)) {
        console.log(
          `  - ${r.table}: ${r.sidOrphans} sid orphans, ${r.nonSidOrphans} non-sid orphans`
        );
        if (r.orphanSamples.length > 0) {
          console.log(`    samples: ${r.orphanSamples.join(", ")}`);
        }
      }
    }

    return 1;
  } finally {
    await sql.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("Audit failed:", e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
