/**
 * Archive all statements and claims data to JSON before deleting the system.
 *
 * Exports from the wiki-server API to data/archived/statements-export.json.
 *
 * Usage:
 *   WIKI_SERVER_ENV=prod npx tsx crux/scripts/archive-statements.ts
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { apiRequest } from "../lib/wiki-server/client.ts";

const OUTPUT_PATH = join(import.meta.dirname, "../../data/archived/statements-export.json");

interface ArchiveData {
  exportedAt: string;
  statements: {
    entityId: string;
    total: number;
    statements: unknown[];
  }[];
  claims: unknown[];
  properties: unknown[];
  coverageScores: unknown[];
}

async function main() {
  const archive: ArchiveData = {
    exportedAt: new Date().toISOString(),
    statements: [],
    claims: [],
    properties: [],
    coverageScores: [],
  };

  // 1. Get all statement properties
  console.log("Fetching statement properties...");
  const propsResult = await apiRequest<{ properties: unknown[] }>(
    "/api/statements/properties"
  );
  if (propsResult.ok) {
    archive.properties = propsResult.data.properties;
    console.log(`  ${archive.properties.length} properties`);
  }

  // 2. Get coverage scores
  console.log("Fetching coverage scores...");
  const scoresResult = await apiRequest<{ scores: unknown[] }>(
    "/api/statements/coverage-scores"
  );
  if (scoresResult.ok) {
    archive.coverageScores = scoresResult.data.scores;
    console.log(`  ${archive.coverageScores.length} coverage scores`);
  }

  // 3. Get all entities that have statements via stats endpoint
  console.log("Fetching statement stats...");
  const statsResult = await apiRequest<{ entityBreakdown: { entityId: string; count: number }[] }>(
    "/api/statements/stats"
  );

  if (!statsResult.ok) {
    console.error("Failed to fetch stats:", statsResult.error);
    // Fallback: try a large list query
    console.log("Trying fallback: fetching all statements...");
    const allResult = await apiRequest<{ statements: unknown[]; total: number }>(
      "/api/statements?limit=10000"
    );
    if (allResult.ok) {
      archive.statements = [{
        entityId: "_all",
        total: allResult.data.total,
        statements: allResult.data.statements,
      }];
      console.log(`  ${allResult.data.total} total statements`);
    }
  } else {
    const entities = statsResult.data.entityBreakdown || [];
    console.log(`  ${entities.length} entities with statements`);

    // 4. Fetch statements per entity
    for (const { entityId, count } of entities) {
      process.stdout.write(`  ${entityId} (${count})...`);
      const result = await apiRequest<{ statements: unknown[]; total: number }>(
        `/api/statements/by-entity?entityId=${encodeURIComponent(entityId)}&limit=10000`
      );
      if (result.ok) {
        archive.statements.push({
          entityId,
          total: result.data.total,
          statements: result.data.statements,
        });
        console.log(` done`);
      } else {
        console.log(` FAILED: ${result.error}`);
      }
    }
  }

  // 5. Get all claims
  console.log("Fetching claims...");
  const claimsResult = await apiRequest<{ claims: unknown[]; total: number }>(
    "/api/claims/all?limit=50000"
  );
  if (claimsResult.ok) {
    archive.claims = claimsResult.data.claims;
    console.log(`  ${archive.claims.length} claims`);
  } else {
    console.log(`  Failed to fetch claims: ${claimsResult.error}`);
  }

  // 6. Write archive
  const json = JSON.stringify(archive, null, 2);
  writeFileSync(OUTPUT_PATH, json);
  const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(1);
  console.log(`\nArchive written to ${OUTPUT_PATH} (${sizeMB} MB)`);
  console.log(`  Statements: ${archive.statements.reduce((n, e) => n + e.total, 0)} across ${archive.statements.length} entities`);
  console.log(`  Claims: ${archive.claims.length}`);
  console.log(`  Properties: ${archive.properties.length}`);
  console.log(`  Coverage scores: ${archive.coverageScores.length}`);
}

main().catch((e) => {
  console.error("Archive failed:", e);
  process.exit(1);
});
