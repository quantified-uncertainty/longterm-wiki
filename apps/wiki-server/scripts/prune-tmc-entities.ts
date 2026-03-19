#!/usr/bin/env node
/**
 * One-time script to prune TMC (AI Transition Model) orphan entities from prod PG.
 *
 * These entity types were bulk-imported but have no YAML source files,
 * no wiki pages, and link to 404s on directory pages.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod npx tsx apps/wiki-server/scripts/prune-tmc-entities.ts
 *   WIKI_SERVER_ENV=prod npx tsx apps/wiki-server/scripts/prune-tmc-entities.ts --dry-run
 *
 * Requires the prune endpoint to accept empty keepIds (server change in this PR).
 */

const TMC_ENTITY_TYPES = [
  "ai-transition-model-factor",
  "ai-transition-model-parameter",
  "ai-transition-model-scenario",
  "ai-transition-model-metric",
  "ai-transition-model-subitem",
];

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

  console.log(`Server: ${serverUrl}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let totalDeleted = 0;

  for (const entityType of TMC_ENTITY_TYPES) {
    try {
      if (dryRun) {
        // In dry-run mode, just count how many would be deleted
        const countRes = await fetch(
          `${serverUrl}/api/entities?entityType=${encodeURIComponent(entityType)}&limit=1`,
          { headers },
        );
        if (countRes.ok) {
          const data = await countRes.json();
          const count = Array.isArray(data) ? data.length : (data.total ?? "?");
          console.log(`  ${entityType}: would prune (count endpoint not available, will delete all)`);
        } else {
          console.log(`  ${entityType}: query returned ${countRes.status}`);
        }
        continue;
      }

      const res = await fetch(`${serverUrl}/api/entities/prune`, {
        method: "POST",
        headers,
        body: JSON.stringify({ entityType, keepIds: [] }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error(`  ${entityType}: HTTP ${res.status} — ${body}`);
        continue;
      }

      const result = await res.json() as { deleted: number; ids: string[] };
      console.log(`  ${entityType}: deleted ${result.deleted} entities`);
      totalDeleted += result.deleted;
    } catch (err) {
      console.error(`  ${entityType}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nTotal deleted: ${totalDeleted}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
