#!/usr/bin/env node
/**
 * One-time script to prune ghost duplicate people entities from prod PG.
 *
 * These entities were created by personnel enrichment tasks with garbled or
 * inverted slug IDs. The correct entries exist under their canonical IDs
 * in data/entities/people.yaml. The ghost entries persist because the
 * sync-entities prune step hadn't been deployed when they were created.
 *
 * This script reads data/entities/people.yaml to build the canonical keepIds
 * list, then calls POST /api/entities/prune to remove any person entities
 * NOT in that list — exactly matching the prune step in sync-entities.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod npx tsx apps/wiki-server/scripts/prune-ghost-people.ts
 *   WIKI_SERVER_ENV=prod npx tsx apps/wiki-server/scripts/prune-ghost-people.ts --dry-run
 *
 * Alternative: run the full sync-entities pipeline (syncs + prunes all types):
 *   WIKI_SERVER_ENV=prod pnpm crux wiki-server sync-entities
 *
 * Related: GitHub issue #2796
 */

import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

const PROJECT_ROOT = join(import.meta.dirname!, "../../..");
const PEOPLE_FILE = join(PROJECT_ROOT, "data/entities/people.yaml");

interface YamlEntity {
  id: string;
  type: string;
  [key: string]: unknown;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Resolve server URL from environment
  const envPrefix = process.env.WIKI_SERVER_ENV === "prod" ? "PROD_" : "";
  const serverUrl = process.env[`${envPrefix}LONGTERMWIKI_SERVER_URL`];
  const apiKey = process.env[`${envPrefix}LONGTERMWIKI_SERVER_API_KEY`];

  if (!serverUrl) {
    console.error("Error: No wiki-server URL configured. Set WIKI_SERVER_ENV=prod or LONGTERMWIKI_SERVER_URL.");
    process.exit(1);
  }

  // Load canonical person IDs from YAML
  const raw = readFileSync(PEOPLE_FILE, "utf-8");
  const parsed = parseYaml(raw) as YamlEntity[];
  if (!Array.isArray(parsed)) {
    console.error("Error: people.yaml is not an array");
    process.exit(1);
  }

  const keepIds = parsed
    .filter((e) => e.id && e.type === "person")
    .map((e) => e.id);

  console.log(`Server: ${serverUrl}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Canonical person IDs from YAML: ${keepIds.length}\n`);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  if (dryRun) {
    // Fetch all person entities from the server to see what would be pruned
    const res = await fetch(
      `${serverUrl}/api/entities?entityType=person&limit=500`,
      { headers },
    );
    if (!res.ok) {
      console.error(`Failed to fetch entities: HTTP ${res.status}`);
      process.exit(1);
    }
    const data = await res.json() as { entities?: Array<{ id: string; title: string }>; total?: number } | Array<{ id: string; title: string }>;
    const items = Array.isArray(data) ? data : (data.entities ?? []);
    const keepSet = new Set(keepIds);
    const stale = items.filter((e) => !keepSet.has(e.id));

    if (stale.length === 0) {
      console.log("No stale person entities found — nothing to prune.");
    } else {
      console.log(`Would prune ${stale.length} stale person entities:`);
      for (const e of stale) {
        console.log(`  ${e.id} — "${e.title}"`);
      }
    }
    return;
  }

  // Call prune endpoint
  const res = await fetch(`${serverUrl}/api/entities/prune`, {
    method: "POST",
    headers,
    body: JSON.stringify({ entityType: "person", keepIds }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Prune failed: HTTP ${res.status} — ${body}`);
    process.exit(1);
  }

  const result = await res.json() as { deleted: number; ids: string[] };
  if (result.deleted > 0) {
    console.log(`Pruned ${result.deleted} stale person entities:`);
    for (const id of result.ids) {
      console.log(`  ${id}`);
    }
  } else {
    console.log("No stale person entities to prune.");
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
