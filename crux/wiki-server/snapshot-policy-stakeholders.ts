/**
 * Policy Stakeholders Snapshot (QUA-960 step 9 / R-B5).
 *
 * Fetches all policy stakeholders from wiki-server PG and writes a snapshot
 * to `data/policy-stakeholders-snapshot.json`. Build-data falls through to
 * this snapshot when the wiki-server is unreachable. Without this fallback,
 * every CI build during a wiki-server outage would fail once the cutover
 * (QUA-960) makes PG authoritative.
 *
 * Snapshot is git-tracked (small file — ~1500 stakeholders, ~600KB) so
 * Vercel/CI builds always have a baseline. Refreshed daily by the
 * `snapshot-policy-stakeholders.yml` workflow and committed back to main.
 *
 * Usage:
 *   pnpm crux wiki-server snapshot-policy-stakeholders
 *   pnpm crux wiki-server snapshot-policy-stakeholders --dry-run
 */

import { writeFileSync, renameSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const SNAPSHOT_FILE = join(PROJECT_ROOT, "data/policy-stakeholders-snapshot.json");
const PAGE_SIZE = 200;

/** Minimum stakeholder count below which a snapshot is rejected as suspicious.
 *  PG holds ~243 rows in production today; a sudden drop to <100 indicates a
 *  partial outage, schema migration in progress, or truncated query, NOT a
 *  legitimate snapshot. The cron caller errors out instead of overwriting a
 *  healthy snapshot with a broken one. Override with --min=N for legitimate
 *  shrink scenarios. */
const DEFAULT_MIN_ROWS = 100;

interface PGPolicyStakeholderRow {
  id: string;
  policyEntityId: string;
  stakeholderEntityId: string | null;
  stakeholderDisplayName: string;
  position: string;
  importance: string | null;
  reason: string | null;
  source: string | null;
  context: string[] | null;
  // syncedAt / createdAt / updatedAt are intentionally excluded — the daily
  // YAML→PG re-sync at 04:00 UTC bumps these on every row, producing
  // ~1500 timestamp diffs per day even when stakeholder data is unchanged.
  // Build-data doesn't read them; stripping them keeps the daily commit
  // diff signal-only.
}

/**
 * Snapshot file shape. Versioned to allow forward-compatible reader changes:
 * if a future column (e.g. `role` from QUA-984) becomes part of the snapshot,
 * the version bumps and old build-data versions can decide whether to use it.
 */
export interface PolicyStakeholdersSnapshot {
  version: 1;
  generatedAt: string;
  count: number;
  stakeholders: PGPolicyStakeholderRow[];
}

export async function generatePolicyStakeholdersSnapshot(options?: {
  dryRun?: boolean;
  quiet?: boolean;
  /** Reject snapshots with fewer rows (defends against partial outages). */
  minRows?: number;
}): Promise<number> {
  const { dryRun = false, quiet = false, minRows = DEFAULT_MIN_ROWS } = options ?? {};
  const log = quiet ? () => {} : console.log.bind(console);

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();
  if (!serverUrl) {
    throw new Error("LONGTERMWIKI_SERVER_URL is required for snapshot generation");
  }
  if (!apiKey) {
    throw new Error("LONGTERMWIKI_SERVER_API_KEY is required for snapshot generation");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  log(`Fetching policy stakeholders from ${serverUrl}...`);

  const allStakeholders: PGPolicyStakeholderRow[] = [];
  let offset = 0;

  while (true) {
    const resp = await fetch(
      `${serverUrl}/api/policy-stakeholders/all?limit=${PAGE_SIZE}&offset=${offset}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
    if (!resp.ok) {
      throw new Error(`API returned ${resp.status} ${resp.statusText}`);
    }
    const data = await resp.json();
    const rawRows = (data.policyStakeholders || []) as Record<string, unknown>[];
    if (rawRows.length === 0) break;
    // Strip noise columns (syncedAt/createdAt/updatedAt) before pushing —
    // see the comment on PGPolicyStakeholderRow above.
    for (const r of rawRows) {
      allStakeholders.push({
        id: r.id as string,
        policyEntityId: r.policyEntityId as string,
        stakeholderEntityId: (r.stakeholderEntityId as string | null) ?? null,
        stakeholderDisplayName: r.stakeholderDisplayName as string,
        position: r.position as string,
        importance: (r.importance as string | null) ?? null,
        reason: (r.reason as string | null) ?? null,
        source: (r.source as string | null) ?? null,
        context: (r.context as string[] | null) ?? null,
      });
    }
    offset += rawRows.length;
    if (rawRows.length < PAGE_SIZE) break;
  }

  log(`  Fetched ${allStakeholders.length} policy stakeholders`);

  if (allStakeholders.length < minRows) {
    throw new Error(
      `Refusing to write snapshot: fetched ${allStakeholders.length} rows but minimum is ${minRows}. ` +
        `This usually indicates a partial outage, schema migration mid-flight, or query truncation. ` +
        `Override with --min=N if a legitimate shrink is expected.`,
    );
  }

  // Byte-stable sort (locale-independent) on `id`, which is a deterministic
  // 10-char hash. Different machines or Node ICU versions would otherwise
  // produce diff churn unrelated to data changes.
  const sorted = [...allStakeholders].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const snapshot: PolicyStakeholdersSnapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    count: sorted.length,
    stakeholders: sorted,
  };

  if (dryRun) {
    log(`\n[dry-run] Would write ${sorted.length} stakeholders to ${SNAPSHOT_FILE}`);
    return sorted.length;
  }

  // Atomic write: snapshot file is the build-data fallback, so a half-written
  // JSON file would brick CI builds during a wiki-server outage.
  const tmpPath = `${SNAPSHOT_FILE}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2) + "\n");
  renameSync(tmpPath, SNAPSHOT_FILE);
  log(`\nSnapshot written to ${SNAPSHOT_FILE}`);
  log(`  Stakeholders: ${sorted.length}`);
  return sorted.length;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  // parseCliArgs returns flag values as strings; coerce + validate so a typo
  // like `--min=abc` errors loud instead of silently falling back to default.
  let minRows: number | undefined;
  if (args.min !== undefined) {
    const parsed = Number(args.min);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      throw new Error(`--min must be a non-negative integer, got: ${JSON.stringify(args.min)}`);
    }
    minRows = parsed;
  }
  await generatePolicyStakeholdersSnapshot({ dryRun, minRows });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Snapshot failed:", err);
    process.exit(1);
  });
}
