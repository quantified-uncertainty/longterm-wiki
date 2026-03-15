#!/usr/bin/env npx tsx
/**
 * Backfill Wayback Machine archive URLs for resources.
 *
 * Queries resources without archive_url, looks up each URL on the
 * Wayback Machine availability API, and stores the result.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod npx tsx scripts/backfill-archive-urls.ts --batch=100
 *   WIKI_SERVER_ENV=prod npx tsx scripts/backfill-archive-urls.ts --batch=50 --type=paper --dry-run
 */

import 'dotenv/config';
import { listResources, upsertResource } from '../crux/lib/wiki-server/resources.ts';

// ── Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1] : defaultVal;
}
const BATCH_SIZE = parseInt(getArg("batch", "100"), 10);
const RESOURCE_TYPE = getArg("type", "");
const DRY_RUN = args.includes("--dry-run");

// ── Wayback Machine API ──────────────────────────────────────────────────

interface WaybackSnapshot {
  url: string;
  timestamp: string;
  available: boolean;
}

async function lookupWayback(url: string): Promise<string | null> {
  try {
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'LongtermWikiArchiveBackfill/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      archived_snapshots?: { closest?: WaybackSnapshot };
    };

    const snapshot = data?.archived_snapshots?.closest;
    if (snapshot?.available && snapshot.url) {
      return snapshot.url;
    }
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching resources without archive URLs (batch=${BATCH_SIZE}, type=${RESOURCE_TYPE || "all"})...`);

  const needsArchive: Array<{ id: string; title: string; url: string; type: string }> = [];
  let offset = 0;
  const PAGE_SIZE = 200;

  while (needsArchive.length < BATCH_SIZE) {
    const result = await listResources(PAGE_SIZE, offset, RESOURCE_TYPE || undefined);
    if (!result.ok) {
      console.error("Failed to list resources:", result.error);
      process.exit(1);
    }

    const items = (result.data as { resources: Array<Record<string, unknown>> }).resources ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      if (needsArchive.length >= BATCH_SIZE) break;
      // Skip resources that already have archive_url
      if (!item.archive_url && item.url && item.title) {
        needsArchive.push({
          id: item.id as string,
          title: item.title as string,
          url: item.url as string,
          type: item.type as string,
        });
      }
    }

    offset += PAGE_SIZE;
    if (offset > 10000) break;
  }

  console.log(`Found ${needsArchive.length} resources without archive URLs`);

  if (DRY_RUN) {
    console.log("\n--- DRY RUN ---");
    for (const r of needsArchive.slice(0, 20)) {
      console.log(`  ${r.type.padEnd(10)} ${r.id.slice(0, 20).padEnd(22)} ${r.title.slice(0, 60)}`);
    }
    return;
  }

  let found = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < needsArchive.length; i++) {
    const resource = needsArchive[i];
    process.stdout.write(`\r[${i + 1}/${needsArchive.length}] Looking up ${resource.url.slice(0, 60)}...`);

    try {
      const archiveUrl = await lookupWayback(resource.url);

      if (archiveUrl) {
        const upsertResult = await upsertResource({
          id: resource.id,
          url: resource.url,
          title: resource.title,
          type: resource.type,
          archiveUrl,
        });

        if (upsertResult.ok) {
          found++;
        } else {
          errors++;
        }
      } else {
        notFound++;
      }
    } catch {
      errors++;
    }

    // Rate limit: 200ms between Wayback API calls
    await sleep(200);
  }

  console.log(`\n\n━━━ Done ━━━`);
  console.log(`  Found:     ${found}`);
  console.log(`  Not found: ${notFound}`);
  console.log(`  Errors:    ${errors}`);
}

main().catch(console.error);
