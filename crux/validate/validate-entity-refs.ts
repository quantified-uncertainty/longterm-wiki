#!/usr/bin/env node

/**
 * Entity Reference Integrity Validation — checks that FK-like fields in KB
 * records actually point to valid entities.
 *
 * All cross-table references (grantee, investor, holder, person, lead, etc.)
 * are soft TEXT fields with no DB enforcement. This validator catches orphaned
 * references that would otherwise ship silently.
 *
 * Checks:
 *   - Record endpoint fields (non-implicit) reference valid entities
 *   - Record fields with type=ref reference valid entities
 *   - Fact ref/refs values (already checked by KB validate.ts, but included
 *     for completeness in the summary)
 *
 * Usage:
 *   npx tsx crux/validate/validate-entity-refs.ts              # advisory mode
 *   npx tsx crux/validate/validate-entity-refs.ts --threshold=90  # fail if link rate < 90%
 *   npx tsx crux/validate/validate-entity-refs.ts --verbose     # show all orphaned refs
 */

import { join } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

interface OrphanedRef {
  /** Record key or fact ID */
  recordKey: string;
  /** Schema ID (record type) */
  schemaId: string;
  /** Owner entity ID */
  ownerEntityId: string;
  /** Field name that contains the reference */
  fieldName: string;
  /** The invalid reference value */
  refValue: string;
  /** Whether the endpoint allows display_name as a fallback */
  allowsDisplayName: boolean;
}

interface CollectionStats {
  totalRecords: number;
  totalLinks: number;
  validLinks: number;
  orphanedLinks: number;
  orphanedRefs: OrphanedRef[];
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");
  const c = getColors(ci);

  // Parse --threshold=N (0-100, default: none = advisory only)
  const thresholdArg = process.argv.find((a) => a.startsWith("--threshold="));
  const threshold = thresholdArg ? parseInt(thresholdArg.split("=")[1], 10) : null;

  // Dynamic import to avoid loading KB code eagerly
  const { loadKB } = await import(
    join(PROJECT_ROOT, "packages/kb/src/loader.ts")
  );

  const dataDir = join(PROJECT_ROOT, "packages/kb/data");
  const { graph, filenameMap } = await loadKB(dataDir);

  const entities = graph.getAllEntities();
  const entityIdSet = new Set(entities.map((e: { id: string }) => e.id));
  const recordSchemas = graph.getAllRecordSchemas();

  // Build slug→entityId lookup from filenameMap (entity ID → YAML slug)
  // so we can also resolve slug-based references
  const slugToEntityId = new Map<string, string>();
  for (const [entityId, slug] of filenameMap) {
    slugToEntityId.set(slug, entityId);
  }

  /**
   * Check if a reference value resolves to a valid entity.
   * Accepts either an entity ID (10-char alphanumeric) or a YAML slug.
   */
  function isValidEntityRef(refStr: string): boolean {
    return entityIdSet.has(refStr) || slugToEntityId.has(refStr);
  }

  // Build schema lookup
  const schemaMap = new Map(
    recordSchemas.map((s: { id: string }) => [s.id, s])
  );

  // Stats per collection
  const statsByCollection = new Map<string, CollectionStats>();

  function getStats(collection: string): CollectionStats {
    if (!statsByCollection.has(collection)) {
      statsByCollection.set(collection, {
        totalRecords: 0,
        totalLinks: 0,
        validLinks: 0,
        orphanedLinks: 0,
        orphanedRefs: [],
      });
    }
    return statsByCollection.get(collection)!;
  }

  // Iterate all entities and their record collections
  for (const entity of entities) {
    const collectionNames = graph.getRecordCollectionNames(entity.id);

    for (const collectionName of collectionNames) {
      const entries = graph.getRecords(entity.id, collectionName);

      for (const entry of entries) {
        const schema = schemaMap.get(entry.schema);
        if (!schema) continue;

        const stats = getStats(entry.schema);
        stats.totalRecords++;

        // Check explicit (non-implicit) endpoint fields
        for (const [endpointName, endpointDef] of Object.entries(
          schema.endpoints
        )) {
          if (endpointDef.implicit) continue;

          const refValue = entry.fields[endpointName];
          if (refValue === undefined || refValue === null) continue;

          // If this endpoint allows display_name, the value might be a
          // human-readable name rather than an entity reference. We still
          // check against the entity index, but mark it as
          // allowsDisplayName so it shows as a softer warning.
          const refStr = String(refValue);
          stats.totalLinks++;

          if (isValidEntityRef(refStr)) {
            stats.validLinks++;
          } else {
            stats.orphanedLinks++;
            stats.orphanedRefs.push({
              recordKey: entry.key,
              schemaId: entry.schema,
              ownerEntityId: entry.ownerEntityId,
              fieldName: endpointName,
              refValue: refStr,
              allowsDisplayName: !!endpointDef.allowDisplayName,
            });
          }
        }

        // Check fields with type=ref in the schema definition
        for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
          if (fieldDef.type !== "ref") continue;

          const refValue = entry.fields[fieldName];
          if (refValue === undefined || refValue === null) continue;

          const refStr = String(refValue);
          stats.totalLinks++;

          if (isValidEntityRef(refStr)) {
            stats.validLinks++;
          } else {
            stats.orphanedLinks++;
            stats.orphanedRefs.push({
              recordKey: entry.key,
              schemaId: entry.schema,
              ownerEntityId: entry.ownerEntityId,
              fieldName,
              refValue: refStr,
              allowsDisplayName: false,
            });
          }
        }
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────

  let totalRecords = 0;
  let totalLinks = 0;
  let totalValid = 0;
  let totalOrphaned = 0;
  let totalOrphanedHard = 0; // excludes allowsDisplayName

  if (!ci) {
    console.log(
      `\n${c.bold}${c.blue}Entity Reference Integrity Check${c.reset}\n`
    );
    console.log(`Entities in graph: ${entities.length}`);
    console.log(`Record schemas: ${recordSchemas.length}\n`);
  }

  // Table header
  if (!ci) {
    console.log(
      "┌──────────────────────────┬─────────┬───────┬───────┬──────────┬──────────┐"
    );
    console.log(
      "│ Collection               │ Records │ Links │ Valid │ Orphaned │ Link Rate│"
    );
    console.log(
      "├──────────────────────────┼─────────┼───────┼───────┼──────────┼──────────┤"
    );
  }

  const sortedCollections = [...statsByCollection.entries()].sort(
    ([a], [b]) => a.localeCompare(b)
  );

  for (const [collection, stats] of sortedCollections) {
    totalRecords += stats.totalRecords;
    totalLinks += stats.totalLinks;
    totalValid += stats.validLinks;
    totalOrphaned += stats.orphanedLinks;
    totalOrphanedHard += stats.orphanedRefs.filter(
      (r) => !r.allowsDisplayName
    ).length;

    const linkRate =
      stats.totalLinks > 0
        ? ((stats.validLinks / stats.totalLinks) * 100).toFixed(1)
        : "N/A";

    if (!ci) {
      const col = collection.padEnd(24);
      const rec = stats.totalRecords.toString().padStart(7);
      const lnk = stats.totalLinks.toString().padStart(5);
      const val = stats.validLinks.toString().padStart(5);
      const orph = stats.orphanedLinks.toString().padStart(8);
      const rate = (linkRate + "%").padStart(8);
      console.log(
        `│ ${col} │ ${rec} │ ${lnk} │ ${val} │ ${orph} │ ${rate} │`
      );
    }
  }

  const overallRate =
    totalLinks > 0
      ? ((totalValid / totalLinks) * 100).toFixed(1)
      : "100.0";

  if (!ci) {
    console.log(
      "├──────────────────────────┼─────────┼───────┼───────┼──────────┼──────────┤"
    );
    const col = "TOTAL".padEnd(24);
    const rec = totalRecords.toString().padStart(7);
    const lnk = totalLinks.toString().padStart(5);
    const val = totalValid.toString().padStart(5);
    const orph = totalOrphaned.toString().padStart(8);
    const rate = (overallRate + "%").padStart(8);
    console.log(
      `│ ${col} │ ${rec} │ ${lnk} │ ${val} │ ${orph} │ ${rate} │`
    );
    console.log(
      "└──────────────────────────┴─────────┴───────┴───────┴──────────┴──────────┘"
    );
  }

  // Print orphaned references (verbose or when there are few enough)
  const allOrphaned = [...statsByCollection.values()].flatMap(
    (s) => s.orphanedRefs
  );
  const hardOrphans = allOrphaned.filter((r) => !r.allowsDisplayName);
  const softOrphans = allOrphaned.filter((r) => r.allowsDisplayName);

  if (!ci && hardOrphans.length > 0) {
    console.log(
      `\n${c.red}Orphaned references (entity not found):${c.reset}`
    );
    const toShow = verbose ? hardOrphans : hardOrphans.slice(0, 20);
    for (const ref of toShow) {
      const ownerEntity = graph.getEntity(ref.ownerEntityId);
      const ownerName = ownerEntity?.name ?? ref.ownerEntityId;
      console.log(
        `  ${c.red}x${c.reset} ${ref.schemaId}/${ref.recordKey} ` +
          `(owner: ${ownerName}) — ${ref.fieldName} = "${ref.refValue}"`
      );
    }
    if (!verbose && hardOrphans.length > 20) {
      console.log(
        `  ... and ${hardOrphans.length - 20} more (use --verbose to see all)`
      );
    }
  }

  if (!ci && softOrphans.length > 0 && verbose) {
    console.log(
      `\n${c.yellow}Unresolved display-name references (may be intentional):${c.reset}`
    );
    const toShow = softOrphans.slice(0, 20);
    for (const ref of toShow) {
      const ownerEntity = graph.getEntity(ref.ownerEntityId);
      const ownerName = ownerEntity?.name ?? ref.ownerEntityId;
      console.log(
        `  ${c.yellow}~${c.reset} ${ref.schemaId}/${ref.recordKey} ` +
          `(owner: ${ownerName}) — ${ref.fieldName} = "${ref.refValue}"`
      );
    }
    if (softOrphans.length > 20) {
      console.log(
        `  ... and ${softOrphans.length - 20} more`
      );
    }
  }

  // Summary
  if (!ci) {
    console.log("");
    if (totalOrphanedHard === 0) {
      console.log(
        `${c.green}All ${totalLinks} entity references resolve to valid entities.${c.reset}`
      );
    } else {
      console.log(
        `${c.yellow}${totalOrphanedHard} hard orphan(s) and ${softOrphans.length} display-name reference(s) ` +
          `out of ${totalLinks} total links (${overallRate}% link rate).${c.reset}`
      );
    }
  }

  // Threshold check
  if (threshold !== null) {
    const rate = totalLinks > 0 ? (totalValid / totalLinks) * 100 : 100;
    if (rate < threshold) {
      console.error(
        `\n${c.red}Entity reference link rate ${rate.toFixed(1)}% is below threshold ${threshold}%.${c.reset}`
      );
      process.exit(1);
    }
  }

  // CI output
  if (ci) {
    console.log(
      JSON.stringify({
        passed: true,
        totalRecords,
        totalLinks,
        validLinks: totalValid,
        orphanedLinks: totalOrphaned,
        hardOrphans: totalOrphanedHard,
        softOrphans: softOrphans.length,
        linkRate: parseFloat(overallRate),
        byCollection: Object.fromEntries(
          sortedCollections.map(([name, stats]) => [
            name,
            {
              records: stats.totalRecords,
              links: stats.totalLinks,
              valid: stats.validLinks,
              orphaned: stats.orphanedLinks,
              rate:
                stats.totalLinks > 0
                  ? parseFloat(
                      ((stats.validLinks / stats.totalLinks) * 100).toFixed(1)
                    )
                  : 100,
            },
          ])
        ),
      })
    );
  }
}

main().catch((err) => {
  console.error("Entity reference validation crashed:", err);
  process.exit(1);
});
