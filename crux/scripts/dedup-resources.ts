/**
 * QUA-561 — One-shot resource dedup job (CLI wrapper).
 *
 * Thin wrapper around POST /api/resources/dedup on the wiki-server, which
 * does the real scan + merge work. This script:
 *   - Calls the endpoint with `apply: false` for a dry-run, or `apply: true`.
 *   - Logs a summary + per-cluster progress to stdout.
 *   - Writes a JSON snapshot to `.claude/snapshots/dedup-resources-*.json`.
 *
 * Usage:
 *   # Dry-run against whichever WIKI_SERVER_ENV is set (default: local).
 *   npx tsx crux/scripts/dedup-resources.ts
 *
 *   # Apply against prod.
 *   WIKI_SERVER_ENV=prod npx tsx crux/scripts/dedup-resources.ts --apply
 *
 * Exit codes: 0 = ok, 1 = error, 2 = partial success (some clusters failed).
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRequest } from "../lib/wiki-server/client.ts";

interface ResourceCandidate {
  id: string;
  url: string;
  createdAt: string;
  refCount: number;
}

interface DedupCluster {
  normalizedUrl: string;
  canonical: ResourceCandidate;
  duplicates: ResourceCandidate[];
}

interface FkColumnInfo {
  tableName: string;
  columnName: string;
  /** QUA-589: which resources column this FK targets — `id` (legacy hex16)
   *  or `stable_id` (canonical sid_, post-Phase B). */
  targetColumn: "id" | "stable_id";
  uniqueGroups: { otherCols: string[] }[];
}

interface DedupReport {
  totalResources: number;
  fkColumns: FkColumnInfo[];
  clusters: DedupCluster[];
  /** QUA-623: true when the server's resources scan hit its cap. Clusters
   *  past the cutoff are invisible to this report; --apply will be refused
   *  server-side with a 409 until the cap is raised or the scan is chunked. */
  truncated?: boolean;
}

interface ClusterMergeResult {
  canonicalId: string;
  duplicateIds: string[];
  fkUpdates: Record<string, { moved: number; deletedOnConflict: number }>;
  resourcesDeleted: number;
}

interface RunDedupResult {
  apply: boolean;
  report: DedupReport;
  merges: ClusterMergeResult[];
  errors: { canonicalId: string; duplicateIds: string[]; message: string }[];
}

function parseArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: dedup-resources.ts [--apply]
  --apply    Execute merges (default: dry-run)
Environment: WIKI_SERVER_ENV=prod to target prod wiki-server.`
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { apply };
}

function logReport(result: RunDedupResult): void {
  const { report, merges, errors, apply } = result;
  if (report.truncated) {
    console.warn(
      `⚠ WARNING: resources scan was TRUNCATED — clusters past the server's cap are not in this report. --apply will be refused by the server until the cap is raised or chunked scanning lands.`,
    );
  }
  console.log(`Total resources: ${report.totalResources}`);
  // QUA-589: discovery includes both resources.id and resources.stable_id targets.
  const idFks = report.fkColumns.filter((f) => f.targetColumn === "id").length;
  const stableFks = report.fkColumns.filter(
    (f) => f.targetColumn === "stable_id",
  ).length;
  console.log(
    `FK columns referencing resources: ${report.fkColumns.length} (` +
      `${idFks} → resources.id, ${stableFks} → resources.stable_id)`,
  );
  console.log(`Duplicate clusters: ${report.clusters.length}`);
  const rowsToDelete = report.clusters.reduce(
    (acc, c) => acc + c.duplicates.length,
    0
  );
  console.log(`Rows to delete after merge: ${rowsToDelete}`);

  if (!apply) {
    console.log(`\nDry-run — no changes written. Sample (up to 10 clusters):`);
    for (const c of report.clusters.slice(0, 10)) {
      console.log(
        `  [${c.duplicates.length + 1} rows] ${c.normalizedUrl}  ` +
          `canonical=${c.canonical.id} (refs=${c.canonical.refCount})`
      );
      for (const d of c.duplicates) {
        console.log(`    drop ${d.id} (refs=${d.refCount}) ${d.url}`);
      }
    }
    return;
  }

  console.log(`\nApplied merges:`);
  let idx = 0;
  for (const cluster of report.clusters) {
    idx++;
    const merge = merges.find((m) => m.canonicalId === cluster.canonical.id);
    const err = errors.find((e) => e.canonicalId === cluster.canonical.id);
    if (err) {
      console.log(
        `  [${idx}/${report.clusters.length}] FAILED ${cluster.normalizedUrl}: ${err.message}`
      );
      continue;
    }
    if (!merge) continue;
    const totalMoves = Object.values(merge.fkUpdates).reduce(
      (acc, v) => acc + v.moved,
      0
    );
    const totalDeletedOnConflict = Object.values(merge.fkUpdates).reduce(
      (acc, v) => acc + v.deletedOnConflict,
      0
    );
    console.log(
      `  [${idx}/${report.clusters.length}] ${cluster.normalizedUrl}  ` +
        `canonical=${cluster.canonical.id} deleted=${merge.resourcesDeleted} ` +
        `fk-moves=${totalMoves} fk-conflicts-resolved=${totalDeletedOnConflict}`
    );
  }
}

function writeSnapshot(result: RunDedupResult): string {
  const snapshotDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../.claude/snapshots"
  );
  mkdirSync(snapshotDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(
    snapshotDir,
    `dedup-resources-${result.apply ? "applied" : "dryrun"}-${ts}.json`
  );
  const snapshot = {
    ticket: "QUA-561",
    generatedAt: new Date().toISOString(),
    apply: result.apply,
    totalResources: result.report.totalResources,
    scanTruncated: result.report.truncated ?? false,
    fkColumns: result.report.fkColumns,
    clustersFound: result.report.clusters.length,
    rowsToDelete: result.report.clusters.reduce(
      (acc, c) => acc + c.duplicates.length,
      0
    ),
    clusters: result.report.clusters,
    merges: result.merges,
    errors: result.errors,
  };
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n");
  return path;
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));
  console.log(`QUA-561 resource dedup (${apply ? "APPLY" : "dry-run"})`);
  console.log(`Calling /api/resources/dedup…`);

  const res = await apiRequest<RunDedupResult>(
    "POST",
    "/api/resources/dedup",
    { apply },
    // Scanning ~23k resources + per-cluster merges can take a minute.
    120_000
  );

  if (!res.ok) {
    console.error(`API call failed: ${res.message}`);
    process.exit(1);
  }

  const result = res.data;
  logReport(result);
  const snapshotPath = writeSnapshot(result);
  console.log(`\nSnapshot written: ${snapshotPath}`);

  if (result.errors.length > 0) {
    console.error(
      `\n${result.errors.length} cluster(s) failed — see snapshot for details.`
    );
    process.exit(2);
  }
}

const isEntryPoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
