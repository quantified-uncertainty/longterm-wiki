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
 * This script checks every Phase B FK table for rows whose `resource_id`
 * either (a) doesn't match the canonical sid_<10> format or (b) doesn't
 * resolve against resources.stable_id.
 *
 * Usage:
 *   DATABASE_URL="$PRODUCTION_DB_URL" npx tsx scripts/audit-resources-fk-format.ts
 *
 * Exit codes:
 *   0 — clean audit
 *   1 — format orphan(s) or non-sid_ row(s) found
 *   2 — unexpected error (missing DATABASE_URL, DB unreachable, missing table)
 */

import postgres from "postgres";
import { ID_FORMAT_REGEXES } from "../src/routes/operational/data-quality.js";

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

const SID_RE = ID_FORMAT_REGEXES.canonical_sid;

type TableStats =
  | {
      table: string;
      total: number;
      nonNull: number;
      sidFormat: number;
      nonSidFormat: number;
      sidOrphans: number;
      nonSidOrphans: number;
      orphanSamples: string[];
    }
  | { table: string; error: string };

async function auditTable(sql: postgres.Sql, table: string): Promise<TableStats> {
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
      COUNT(*) FILTER (WHERE resource_id ~ ${SID_RE})::text AS sid_format,
      COUNT(*) FILTER (WHERE resource_id IS NOT NULL AND resource_id !~ ${SID_RE})::text AS non_sid_format,
      COUNT(*) FILTER (
        WHERE resource_id ~ ${SID_RE}
          AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = ${sql(table)}.resource_id)
      )::text AS sid_orphans,
      COUNT(*) FILTER (
        WHERE resource_id IS NOT NULL
          AND resource_id !~ ${SID_RE}
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
    console.error("DATABASE_URL must be set.");
    console.error('Example: DATABASE_URL="$PRODUCTION_DB_URL" npx tsx apps/wiki-server/scripts/audit-resources-fk-format.ts');
    return 2;
  }

  const sql = postgres(url, { max: 3, idle_timeout: 30 });

  try {
    console.log(`Auditing ${PHASE_B_TABLES.length} Phase B FK tables for resource_id format orphans...\n`);

    // Parallelize up to the pool's max connections; preserve input order on output.
    const results: TableStats[] = await Promise.all(
      PHASE_B_TABLES.map((table) =>
        auditTable(sql, table).catch((err): TableStats => ({
          table,
          error: err instanceof Error ? err.message : String(err),
        }))
      )
    );

    console.log(
      "table                        | total    | non-null | sid_  | non-sid | sid-orph | non-sid-orph"
    );
    console.log(
      "-----------------------------+----------+----------+-------+---------+----------+-------------"
    );
    for (const r of results) {
      if ("error" in r) {
        console.log(`${r.table.padEnd(28)} | ERROR: ${r.error}`);
        continue;
      }
      console.log(
        `${r.table.padEnd(28)} | ${String(r.total).padStart(8)} | ${String(r.nonNull).padStart(8)} | ${String(r.sidFormat).padStart(5)} | ${String(r.nonSidFormat).padStart(7)} | ${String(r.sidOrphans).padStart(8)} | ${String(r.nonSidOrphans).padStart(12)}`
      );
    }

    const errored = results.filter((r): r is { table: string; error: string } => "error" in r);
    const clean = results.filter((r): r is Exclude<TableStats, { error: string }> => !("error" in r));
    const totalOrphans = clean.reduce((sum, r) => sum + r.sidOrphans + r.nonSidOrphans, 0);
    const nonSidFormat = clean.reduce((sum, r) => sum + r.nonSidFormat, 0);

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
      for (const r of clean.filter((x) => x.nonSidFormat > 0)) {
        console.log(`  - ${r.table}: ${r.nonSidFormat} non-sid rows`);
      }
    }

    if (totalOrphans > 0) {
      console.log(`✗ ${totalOrphans} orphan(s) (resource_id with no matching resources.stable_id):`);
      for (const r of clean.filter((x) => x.sidOrphans + x.nonSidOrphans > 0)) {
        console.log(`  - ${r.table}: ${r.sidOrphans} sid orphans, ${r.nonSidOrphans} non-sid orphans`);
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
