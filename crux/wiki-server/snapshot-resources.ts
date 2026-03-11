/**
 * Resources Snapshot
 *
 * Fetches all resources from the wiki-server PG database and writes
 * a snapshot JSON file. This snapshot serves as a fallback for builds
 * when the wiki-server is unavailable.
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

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    console.error("Error: LONGTERMWIKI_SERVER_URL is required");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("Error: LONGTERMWIKI_SERVER_API_KEY is required");
    process.exit(1);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  console.log(`Fetching resources from ${serverUrl}...`);

  const allResources: PGResource[] = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const resp = await fetch(
      `${serverUrl}/api/resources/all?limit=${limit}&offset=${offset}`,
      { headers, signal: AbortSignal.timeout(30_000) }
    );

    if (!resp.ok) {
      console.error(`Error: API returned ${resp.status} ${resp.statusText}`);
      process.exit(1);
    }

    const data = await resp.json();
    const rows = (data.resources || []) as PGResource[];
    if (rows.length === 0) break;

    allResources.push(...rows);
    offset += rows.length;
    if (rows.length < limit) break;
  }

  console.log(`  Fetched ${allResources.length} resources`);

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

  // Transform to YAML-compatible snake_case format
  const snapshot = allResources.map((r) => {
    const entry: Record<string, unknown> = {
      id: r.id,
      url: r.url,
    };
    if (r.title) entry.title = r.title;
    if (r.type) entry.type = r.type;
    if (r.summary) entry.summary = r.summary;
    if (r.review) entry.review = r.review;
    if (r.abstract) entry.abstract = r.abstract;
    if (r.keyPoints) entry.key_points = r.keyPoints;
    if (r.publicationId) entry.publication_id = r.publicationId;
    if (r.authors) entry.authors = r.authors;
    if (r.publishedDate) entry.published_date = r.publishedDate;
    if (r.tags) entry.tags = r.tags;
    if (r.localFilename) entry.local_filename = r.localFilename;
    if (r.credibilityOverride != null) entry.credibility_override = r.credibilityOverride;
    if (r.fetchedAt) entry.fetched_at = r.fetchedAt;
    if (r.contentHash) entry.content_hash = r.contentHash;
    if (r.stableId) entry.stable_id = r.stableId;
    const citedBy = citationsIndex[r.id];
    if (citedBy && citedBy.length > 0) entry.cited_by = citedBy;
    return entry;
  });

  if (dryRun) {
    console.log(`\n[dry-run] Would write ${snapshot.length} resources to ${SNAPSHOT_FILE}`);
    console.log(`  Citations: ${citationCount} total`);
    console.log(`  Sample entry:`, JSON.stringify(snapshot[0], null, 2).slice(0, 200));
    return;
  }

  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  console.log(`\nSnapshot written to ${SNAPSHOT_FILE}`);
  console.log(`  Resources: ${snapshot.length}`);
  console.log(`  Citations: ${citationCount}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Snapshot failed:", err);
    process.exit(1);
  });
}
