/**
 * Resources Snapshot
 *
 * Fetches all resources from the wiki-server PG database and writes
 * a snapshot JSON file. This snapshot serves as a fallback for local
 * development builds when the wiki-server is unavailable.
 *
 * The snapshot is NOT git-tracked (gitignored) to avoid ~640MB/year
 * of history bloat. CI and Vercel builds fetch resources directly
 * from PG. The snapshot is generated daily by CI and uploaded as a
 * GitHub Actions artifact with 30-day retention. See #2079.
 *
 * Large text fields (summary, review, abstract, key_points) are
 * excluded to keep the file small (~1.8MB vs ~2.7MB). These fields
 * are available from PG in normal builds. See #2073.
 *
 * Usage:
 *   pnpm crux wiki-server snapshot-resources
 *   pnpm crux wiki-server snapshot-resources --dry-run
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL     Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY Bearer token for authentication
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const SNAPSHOT_FILE = join(PROJECT_ROOT, "data/resources-snapshot.json");

interface PGResource {
  id: string;
  url: string;
  title: string | null;
  type: string | null;
  summary: string | null;
  review: string | null;
  abstract: string | null;
  keyPoints: string[] | null;
  publicationId: string | null;
  authors: string[] | null;
  publishedDate: string | null;
  tags: string[] | null;
  localFilename: string | null;
  credibilityOverride: number | null;
  fetchedAt: string | null;
  contentHash: string | null;
  stableId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fetch all resources from PG and write the snapshot file.
 *
 * This is the reusable core of the snapshot-resources command. It can be
 * called programmatically (e.g., fire-and-forget after saveResources())
 * or from the CLI entry point below.
 *
 * @param options.dryRun  If true, logs what would be written but doesn't write.
 * @param options.quiet   If true, suppresses progress logging (for background use).
 * @returns The number of resources written to the snapshot.
 */
export async function generateSnapshot(options?: {
  dryRun?: boolean;
  quiet?: boolean;
}): Promise<number> {
  const { dryRun = false, quiet = false } = options ?? {};
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

  log(`Fetching resources from ${serverUrl}...`);

  const allResources: PGResource[] = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const resp = await fetch(
      `${serverUrl}/api/resources/all?limit=${limit}&offset=${offset}`,
      { headers, signal: AbortSignal.timeout(30_000) }
    );

    if (!resp.ok) {
      throw new Error(`API returned ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    const rows = (data.resources || []) as PGResource[];
    if (rows.length === 0) break;

    allResources.push(...rows);
    offset += rows.length;
    if (rows.length < limit) break;
  }

  log(`  Fetched ${allResources.length} resources`);

  // Fetch citations
  let citationCount = 0;
  const citationsIndex: Record<string, string[]> = {};
  try {
    const citResp = await fetch(`${serverUrl}/api/resources/citations/all`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (citResp.ok) {
      const citData = await citResp.json();
      Object.assign(citationsIndex, citData.citations || {});
      citationCount = citData.count || 0;
    }
  } catch (err) {
    console.warn(
      `  Warning: failed to fetch citations (${err instanceof Error ? err.message : String(err)})`
    );
  }

  // Transform to snake_case format, excluding large text fields to keep
  // the snapshot small. Omitted: summary, review, abstract, key_points
  // (~45% of full size). These are available from PG at build time.
  const snapshot = allResources.map((r) => {
    const entry: Record<string, unknown> = {
      id: r.id,
      url: r.url,
    };
    if (r.title) entry.title = r.title;
    if (r.type) entry.type = r.type;
    if (r.publicationId) entry.publication_id = r.publicationId;
    if (r.authors) entry.authors = r.authors;
    if (r.publishedDate) entry.published_date = r.publishedDate;
    if (r.tags) entry.tags = r.tags;
    if (r.localFilename) entry.local_filename = r.localFilename;
    if (r.credibilityOverride != null) entry.credibility_override = r.credibilityOverride;
    if (r.fetchedAt) entry.fetched_at = r.fetchedAt;
    if (r.stableId != null) entry.stable_id = r.stableId;
    const citedBy = citationsIndex[r.id];
    if (citedBy && citedBy.length > 0) entry.cited_by = citedBy;
    return entry;
  });

  if (dryRun) {
    log(`\n[dry-run] Would write ${snapshot.length} resources to ${SNAPSHOT_FILE}`);
    log(`  Citations: ${citationCount} total`);
    if (snapshot[0]) {
      log(`  Sample entry:`, JSON.stringify(snapshot[0], null, 2).slice(0, 200));
    }
    return snapshot.length;
  }

  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  log(`\nSnapshot written to ${SNAPSHOT_FILE}`);
  log(`  Resources: ${snapshot.length}`);
  log(`  Citations: ${citationCount}`);
  return snapshot.length;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;

  await generateSnapshot({ dryRun });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Snapshot failed:", err);
    process.exit(1);
  });
}
