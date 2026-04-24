/**
 * Ingest MIT AI Incident Database (AIID) weekly snapshot.
 *
 * Usage:
 *   pnpm crux aiid ingest                        # fetch, parse, sync to wiki-server
 *   pnpm crux aiid ingest --dry-run              # fetch + parse; no sync
 *   pnpm crux aiid ingest --url=<specific-url>   # pin a specific snapshot
 *   pnpm crux aiid ingest --input=<local-tarball> # skip download, use local file
 *   pnpm crux aiid ingest --limit=500            # limit incidents processed (smoke test)
 *   pnpm crux aiid ingest --no-resolve           # skip entity attribution fetch
 *   pnpm crux aiid check-url                     # print latest snapshot URL
 *
 * AIID license: CC-BY-SA 4.0, except `submissions` and `reports.text` —
 * both excluded. We never persist report bodies; see
 * `crux/lib/aiid/transform.ts::EXCLUDED_REPORT_BODY_FIELDS` and the
 * `validate-aiid-no-report-text.ts` gate check.
 *
 * Phase 6 of QUA-687 (QUA-693).
 */

import { statSync } from "fs";
import type { CommandResult } from "../lib/command-types.ts";
import {
  AIID_R2_BASE,
  cleanupDir,
  discoverLatestSnapshotUrl,
  downloadSnapshot,
  extractSnapshot,
  loadSnapshotCollections,
} from "../lib/aiid/fetch.ts";
import {
  buildAiidEntityNameMap,
  indexReportsByNumber,
  resolveIncidentReports,
  transformIncident,
  type AiIncidentSyncItem,
} from "../lib/aiid/transform.ts";
import { getServerUrl } from "../lib/wiki-server/client.ts";
import { exportEntities } from "../lib/wiki-server/entities.ts";
import { syncAiIncidents } from "../lib/wiki-server/ai-incidents.ts";

const DEFAULT_BATCH = 100;

async function fetchOurEntityIndex(
  log: (line: string) => void,
): Promise<Map<string, string>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod.",
    );
  }

  const index = new Map<string, string>();
  let offset = 0;
  const limit = 1000;
  let fetched = 0;
  // Defensive upper bound — at 1000/page this caps ingest at 10k orgs per
  // run, which is far above the current ~3k catalog. If we grow past this,
  // fail loudly rather than silently truncate.
  for (let page = 0; page < 10; page++) {
    const res = await exportEntities({
      limit,
      offset,
      entityType: "organization",
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch entities catalog: ${res.message}`);
    }
    const rows = res.data.entities as unknown as Array<{
      title: string;
      stableId: string | null;
      aliases?: string[] | null;
    }>;
    for (const r of rows) {
      if (!r.stableId) continue;
      const primary = r.title?.trim();
      if (primary) {
        const key = primary.toLowerCase();
        if (!index.has(key)) index.set(key, r.stableId);
      }
      for (const alias of r.aliases ?? []) {
        const ak = alias?.trim().toLowerCase();
        if (!ak) continue;
        if (!index.has(ak)) index.set(ak, r.stableId);
      }
    }
    fetched += rows.length;
    if (rows.length < limit) break;
    offset += limit;
  }
  log(
    `  Loaded ${fetched} org entities → ${index.size} name keys for attribution`,
  );
  return index;
}

async function syncItemsInBatches(
  items: AiIncidentSyncItem[],
  batchSize: number,
  log: (line: string) => void,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const res = await syncAiIncidents(
      chunk as unknown as Array<Record<string, unknown>>,
    );
    if (!res.ok) {
      throw new Error(
        `AIID sync batch failed at offset ${i}: ${res.message}`,
      );
    }
    total += res.data.upserted;
    log(
      `  Batch ${Math.floor(i / batchSize) + 1}: upserted ${res.data.upserted}/${chunk.length}`,
    );
  }
  return total;
}

async function runIngest(
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  const dryRun =
    options["dry-run"] === true || options.dryRun === true;
  const batchSize = options.batch ? Number(options.batch) : DEFAULT_BATCH;
  const limitN = options.limit ? Number(options.limit) : undefined;
  const noResolve =
    options["no-resolve"] === true || options.noResolve === true;

  // 1. Resolve archive path (download, or use local).
  let archivePath: string;
  let snapshotUrl: string;
  if (typeof options.input === "string" && options.input.length > 0) {
    archivePath = options.input;
    snapshotUrl = `file://${archivePath}`;
    const st = statSync(archivePath);
    log(
      `Using local archive ${archivePath} (${(st.size / (1024 * 1024)).toFixed(1)} MB)`,
    );
  } else {
    snapshotUrl =
      typeof options.url === "string" && options.url.length > 0
        ? options.url
        : await discoverLatestSnapshotUrl();
    if (!snapshotUrl.startsWith(AIID_R2_BASE)) {
      return {
        exitCode: 1,
        output: `Refusing to download from unexpected host: ${snapshotUrl} (expected ${AIID_R2_BASE})`,
      };
    }
    log(`Downloading AIID snapshot from ${snapshotUrl} ...`);
    archivePath = await downloadSnapshot(snapshotUrl);
    const st = statSync(archivePath);
    log(
      `  Downloaded ${(st.size / (1024 * 1024)).toFixed(1)} MB → ${archivePath}`,
    );
  }

  const upstreamFetchedAt = new Date().toISOString();

  // 2. Extract.
  log(`Extracting archive ...`);
  const extractDir = extractSnapshot(archivePath);
  log(`  Extracted to ${extractDir}`);

  try {
    // 3. Parse collections.
    log(`Loading collections ...`);
    const { incidents, reports, entities: aiidEntities } =
      loadSnapshotCollections(extractDir);
    log(
      `  Parsed ${incidents.length} incidents, ${reports.length} reports, ${aiidEntities.length} AIID entities`,
    );

    // 4. Build lookups.
    const aiidEntityNames = buildAiidEntityNameMap(aiidEntities);
    const reportIndex = indexReportsByNumber(reports);

    let ourEntityIndex: Map<string, string>;
    if (noResolve || dryRun) {
      log(
        `  Skipping wiki-server entities fetch (--no-resolve or --dry-run)`,
      );
      ourEntityIndex = new Map();
    } else {
      log(`Fetching our entities catalog for attribution ...`);
      ourEntityIndex = await fetchOurEntityIndex(log);
    }

    // 5. Transform each incident.
    log(`Transforming incidents ...`);
    const items: AiIncidentSyncItem[] = [];
    const toProcess = limitN ? incidents.slice(0, limitN) : incidents;
    for (const inc of toProcess) {
      if (typeof inc.incident_id !== "number") continue;
      const linkedReports = resolveIncidentReports(inc, reportIndex);
      items.push(
        transformIncident(inc, linkedReports, {
          upstreamFetchedAt,
          aiidEntityNames,
          ourEntityIndex,
        }),
      );
    }

    const attributedOrg = items.filter((i) => i.orgId).length;
    const attributedDev = items.filter((i) => i.developerOrgId).length;
    log(
      `  Transformed ${items.length} incidents (${attributedOrg} with org attribution, ${attributedDev} with developer attribution)`,
    );

    // 6. Sync (unless dry-run).
    if (dryRun) {
      log(`(dry run — no sync)`);
      if (items.length > 0) {
        const sample = { ...items[0], raw: "<redacted>" };
        log(`  Sample item: ${JSON.stringify(sample)}`);
      }
      return { exitCode: 0, output: lines.join("\n") };
    }

    log(`Syncing ${items.length} incidents to wiki-server ...`);
    const upserted = await syncItemsInBatches(items, batchSize, log);
    log(`Done — upserted ${upserted} incidents.`);
    return { exitCode: 0, output: lines.join("\n") };
  } finally {
    cleanupDir(extractDir);
  }
}

async function runCheckUrl(): Promise<CommandResult> {
  const lines: string[] = [];
  lines.push(`AIID snapshots page: https://incidentdatabase.ai/research/snapshots`);
  lines.push(`R2 base:              ${AIID_R2_BASE}`);
  lines.push(`Discovering latest snapshot ...`);
  try {
    const url = await discoverLatestSnapshotUrl();
    lines.push(`  Latest: ${url}`);
    return { exitCode: 0, output: lines.join("\n") };
  } catch (e) {
    return {
      exitCode: 1,
      output:
        lines.join("\n") +
        "\n" +
        `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export const commands = {
  ingest: async (
    _args: string[],
    options: Record<string, unknown>,
  ): Promise<CommandResult> => runIngest(options),
  "check-url": async (): Promise<CommandResult> => runCheckUrl(),
};
