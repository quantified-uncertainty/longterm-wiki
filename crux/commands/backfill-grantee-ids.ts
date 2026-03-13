/**
 * Backfill granteeId in the grants table with matched entity stableIds.
 *
 * Existing grants may have display names (e.g. "OpenAI") in granteeId instead
 * of entity stableIds (e.g. "OwXl35e7bg"). This command uses the entity matcher
 * to retroactively link grantees to their entity pages.
 *
 * Usage:
 *   pnpm crux backfill-grantee-ids run                # Apply updates
 *   pnpm crux backfill-grantee-ids run --dry-run      # Preview without writing
 */

import {
  buildEntityMatcher,
  matchGrantee,
} from "../lib/grant-import/entity-matcher.ts";
import { isNumericGranteeId } from "../lib/grant-import/sync.ts";
import {
  batchedRequest,
  getServerUrl,
} from "../lib/wiki-server/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GrantIdRow {
  id: string;
  granteeId: string | null;
  name: string;
}

interface AllGranteeIdsResponse {
  grants: GrantIdRow[];
  total: number;
}

interface BatchUpdateResult {
  updated: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A 10-char alphanumeric stableId looks like "aB3cD4eF5g".
 * Display names are typically longer or contain spaces/punctuation.
 */
function looksLikeStableId(value: string): boolean {
  return /^[A-Za-z0-9]{10}$/.test(value);
}

const BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function runBackfill(dryRun: boolean): Promise<void> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
  }

  // 1. Build entity matcher
  console.log("Building entity matcher...");
  const matcher = buildEntityMatcher();
  console.log(`  Entity matcher loaded (${matcher.allNames.size} known names)\n`);

  // 2. Fetch all grant IDs and granteeIds
  console.log(`Fetching grants from ${serverUrl}...`);
  const result = await batchedRequest<AllGranteeIdsResponse>(
    "GET",
    "/api/grants/all-grantee-ids"
  );

  if (!result.ok) {
    throw new Error(`Failed to fetch grants: ${result.message}`);
  }

  const allGrants = result.data.grants;
  console.log(`  Total grants: ${allGrants.length}\n`);

  // 3. Categorize grants
  const alreadyLinked: GrantIdRow[] = [];
  const noGranteeId: GrantIdRow[] = [];
  const numericIds: GrantIdRow[] = [];
  const needsMatching: GrantIdRow[] = [];

  for (const grant of allGrants) {
    if (!grant.granteeId) {
      noGranteeId.push(grant);
    } else if (looksLikeStableId(grant.granteeId)) {
      alreadyLinked.push(grant);
    } else if (isNumericGranteeId(grant.granteeId)) {
      numericIds.push(grant);
    } else {
      needsMatching.push(grant);
    }
  }

  console.log("=== Grant Categorization ===");
  console.log(`  Already linked (stableId):  ${alreadyLinked.length}`);
  console.log(`  No granteeId (null):        ${noGranteeId.length}`);
  console.log(`  Numeric IDs (to clear):     ${numericIds.length}`);
  console.log(`  Display names (to match):   ${needsMatching.length}\n`);

  // Show numeric IDs that will be cleared
  if (numericIds.length > 0) {
    const uniqueIds = new Map<string, number>();
    for (const g of numericIds) {
      uniqueIds.set(g.granteeId!, (uniqueIds.get(g.granteeId!) || 0) + 1);
    }
    console.log(`Numeric grantee IDs (${uniqueIds.size} unique, will be set to null):`);
    for (const [id, count] of [...uniqueIds.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count.toString().padStart(4)}x  "${id}"`);
    }
    console.log("");
  }

  // 4. Match display names to entity stableIds
  const matched: Array<{ id: string; granteeId: string; oldValue: string }> = [];
  const unmatched: Map<string, number> = new Map(); // name -> count

  for (const grant of needsMatching) {
    const displayName = grant.granteeId!;
    const stableId = matchGrantee(displayName, matcher);

    if (stableId) {
      matched.push({ id: grant.id, granteeId: stableId, oldValue: displayName });
    } else {
      const count = unmatched.get(displayName) || 0;
      unmatched.set(displayName, count + 1);
    }
  }

  console.log("=== Matching Results ===");
  console.log(`  Newly matched:   ${matched.length}`);
  console.log(`  Still unmatched:  ${needsMatching.length - matched.length}\n`);

  // 5. Show sample matches
  if (matched.length > 0) {
    console.log("Sample matches (first 20):");
    for (const m of matched.slice(0, 20)) {
      console.log(`  "${m.oldValue}" -> ${m.granteeId}`);
    }
    if (matched.length > 20) {
      console.log(`  ... and ${matched.length - 20} more\n`);
    } else {
      console.log("");
    }
  }

  // 6. Show unmatched names (sorted by frequency)
  if (unmatched.size > 0) {
    const sorted = [...unmatched.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`Unmatched names (${sorted.length} unique, top 30 by frequency):`);
    for (const [name, count] of sorted.slice(0, 30)) {
      console.log(`  ${count.toString().padStart(4)}x  "${name}"`);
    }
    if (sorted.length > 30) {
      console.log(`  ... and ${sorted.length - 30} more unique names\n`);
    } else {
      console.log("");
    }
  }

  // 7. Build combined update list: matched display names + numeric IDs to clear
  const toClear: Array<{ id: string; granteeId: string | null; oldValue: string }> =
    numericIds.map((g) => ({ id: g.id, granteeId: null, oldValue: g.granteeId! }));
  const allUpdates = [...matched, ...toClear];

  if (allUpdates.length === 0) {
    console.log("No grants to update.");
    return;
  }

  if (toClear.length > 0) {
    console.log(`Will clear ${toClear.length} numeric grantee IDs (set to null)`);
  }

  if (dryRun) {
    console.log(`Dry run — would update ${allUpdates.length} grants (${matched.length} matched + ${toClear.length} cleared). Use without --dry-run to apply.`);
    return;
  }

  console.log(`Updating ${allUpdates.length} grants...`);

  let totalUpdated = 0;
  let failedBatches = 0;

  for (let i = 0; i < allUpdates.length; i += BATCH_SIZE) {
    const batch = allUpdates.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allUpdates.length / BATCH_SIZE);

    console.log(`  Batch ${batchNum}/${totalBatches}: ${batch.length} grants...`);

    const updateResult = await batchedRequest<BatchUpdateResult>(
      "PATCH",
      "/api/grants/batch-update-grantee",
      {
        items: batch.map((m) => ({ id: m.id, granteeId: m.granteeId })),
      }
    );

    if (updateResult.ok) {
      totalUpdated += updateResult.data.updated;
      console.log(`    -> ${updateResult.data.updated} updated`);
    } else {
      failedBatches++;
      console.error(`    x Batch ${batchNum} failed: ${updateResult.message}`);
    }
  }

  console.log(`\nTotal updated: ${totalUpdated}`);
  if (failedBatches > 0) {
    throw new Error(`${failedBatches} batch(es) failed`);
  }

  console.log("Done.");
}

// ---------------------------------------------------------------------------
// Crux command exports
// ---------------------------------------------------------------------------

type CommandResult = { exitCode?: number; output?: string };

async function runCommand(
  _args: string[],
  options: Record<string, unknown>
): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  await runBackfill(dryRun);
  return { exitCode: 0 };
}

export const commands = {
  run: runCommand,
  default: runCommand,
};

export function getHelp(): string {
  return `
Backfill Grantee IDs — Link existing grants to entity stableIds

Commands:
  run                  Run the backfill (default)
  run --dry-run        Preview matches without writing

This command:
  1. Fetches all grants from the wiki-server
  2. Identifies grants where granteeId is a display name (not a 10-char stableId)
  3. Clears purely numeric grantee IDs (internal IDs from external systems)
  4. Runs the entity matcher (manual overrides + name normalization)
  5. Updates matched grants with the entity stableId
  6. Reports unmatched names (can be added as manual overrides)
`;
}
