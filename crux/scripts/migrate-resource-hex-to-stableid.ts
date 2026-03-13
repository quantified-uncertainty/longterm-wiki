/**
 * Migrate <R id="..."> references in MDX files from hex hash IDs to stableIds.
 *
 * Phase 5 of PG-Native Resources plan (discussion #2021).
 * Resources in the PG database have both a 16-char hex hash ID (primary key)
 * and a 10-char alphanumeric stableId. This script converts MDX references
 * from hex IDs to stableIds for consistency with the broader ID system.
 *
 * The mapping is fetched from the wiki-server's /api/resources/all endpoint.
 * Falls back to a local mapping file if the wiki-server is unavailable.
 *
 * Usage:
 *   pnpm tsx crux/scripts/migrate-resource-hex-to-stableid.ts --dry-run   # preview changes (default)
 *   pnpm tsx crux/scripts/migrate-resource-hex-to-stableid.ts --apply      # apply changes
 *   pnpm tsx crux/scripts/migrate-resource-hex-to-stableid.ts --apply --mapping=/path/to/mapping.json
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRequest } from "../lib/wiki-server/client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = join(__dirname, "../../content/docs");

// Matches <R id="HEX16"> or <R id='HEX16'> — 16-char lowercase hex hash IDs
const R_HEX_RE = /<R(\s+)id=(["'])([0-9a-f]{16})\2/g;

// ---------------------------------------------------------------------------
// Mapping loader
// ---------------------------------------------------------------------------

interface ResourceEntry {
  id: string;
  stableId: string | null;
}

interface ResourceAllResponse {
  resources: ResourceEntry[];
}

async function fetchMappingFromServer(): Promise<Map<string, string> | null> {
  const mapping = new Map<string, string>();
  let offset = 0;
  const limit = 200;

  while (true) {
    const result = await apiRequest<ResourceAllResponse>(
      "GET",
      `/api/resources/all?limit=${limit}&offset=${offset}`,
      undefined,
      30000
    );
    if (!result.ok) {
      if (offset === 0) return null; // Can't reach server at all
      console.error(`Warning: fetch failed at offset ${offset}: ${result.message}`);
      break;
    }
    for (const r of result.data.resources) {
      if (r.stableId) {
        mapping.set(r.id, r.stableId);
      }
    }
    if (result.data.resources.length < limit) break;
    offset += limit;
  }

  return mapping;
}

async function loadMapping(
  mappingPath?: string
): Promise<Map<string, string>> {
  // Try explicit mapping file first
  if (mappingPath) {
    const raw = await readFile(mappingPath, "utf-8");
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  }

  // Try wiki-server
  console.log("Fetching hex->stableId mapping from wiki-server...");
  const serverMapping = await fetchMappingFromServer();
  if (serverMapping && serverMapping.size > 0) {
    console.log(`  Loaded ${serverMapping.size} mappings from wiki-server`);
    return serverMapping;
  }

  throw new Error(
    "Could not load hex->stableId mapping. " +
      "Set LONGTERMWIKI_SERVER_URL or use --mapping=/path/to/mapping.json"
  );
}

// ---------------------------------------------------------------------------
// MDX file walker
// ---------------------------------------------------------------------------

async function walkMDX(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (extname(entry.name) === ".mdx") {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results.sort();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = !apply;
  const mappingArg = args.find((a) => a.startsWith("--mapping="));
  const mappingPath = mappingArg?.split("=")[1];

  if (dryRun) {
    console.log("DRY RUN — pass --apply to write changes\n");
  }

  const mapping = await loadMapping(mappingPath);

  const files = await walkMDX(CONTENT_DIR);

  let totalReplacements = 0;
  let filesChanged = 0;
  let unmappedCount = 0;
  const unmappedIds = new Set<string>();

  for (const filepath of files) {
    const content = await readFile(filepath, "utf-8");

    // Count matches first
    const matches = [...content.matchAll(R_HEX_RE)];
    if (matches.length === 0) continue;

    // Check for unmapped IDs
    let hasUnmapped = false;
    for (const m of matches) {
      const hexId = m[3];
      if (!mapping.has(hexId)) {
        unmappedIds.add(hexId);
        hasUnmapped = true;
      }
    }

    // Replace hex IDs with stableIds
    const updated = content.replace(
      R_HEX_RE,
      (_match, ws: string, quote: string, hexId: string) => {
        const stableId = mapping.get(hexId);
        if (!stableId) return _match; // Leave unmapped IDs unchanged
        return `<R${ws}id=${quote}${stableId}${quote}`;
      }
    );

    if (updated === content) continue; // idempotent: no changes needed

    const changeCount = matches.filter((m) => mapping.has(m[3])).length;
    const relative = filepath.replace(CONTENT_DIR + "/", "");
    filesChanged++;
    totalReplacements += changeCount;

    if (dryRun) {
      console.log(`  ${relative}: ${changeCount} replacement(s)`);
      if (hasUnmapped) {
        const fileUnmapped = matches
          .filter((m) => !mapping.has(m[3]))
          .map((m) => m[3]);
        console.log(`    unmapped: ${fileUnmapped.join(", ")}`);
      }
    } else {
      await writeFile(filepath, updated, "utf-8");
      console.log(`  ${relative}: ${changeCount} replacement(s) written`);
    }
  }

  unmappedCount = unmappedIds.size;

  console.log(`\n--- Summary ---`);
  console.log(`Files scanned:  ${files.length}`);
  console.log(`Files changed:  ${filesChanged}`);
  console.log(`Replacements:   ${totalReplacements}`);
  if (unmappedCount > 0) {
    console.log(`Unmapped IDs:   ${unmappedCount}`);
    console.log(
      `  ${[...unmappedIds].slice(0, 10).join(", ")}${unmappedCount > 10 ? "..." : ""}`
    );
  }
  if (dryRun) {
    console.log(`\nPass --apply to write changes.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
