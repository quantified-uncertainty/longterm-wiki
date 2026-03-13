/**
 * Backfill programId in the grants table by matching grants to funding programs.
 *
 * Uses the program matcher (source + funder + focusArea patterns) to link
 * existing grants to their funding programs. This is the retroactive version
 * of what the import pipeline does for new grants.
 *
 * Usage:
 *   pnpm crux backfill-program-ids run                # Apply updates
 *   pnpm crux backfill-program-ids run --dry-run      # Preview without writing
 */

import {
  matchProgram,
  getAllProgramIds,
  PROGRAM_IDS,
} from "../lib/grant-import/program-matcher.ts";
import {
  batchedRequest,
  getServerUrl,
} from "../lib/wiki-server/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GrantRow {
  id: string;
  programId: string | null;
  organizationId: string;
  source: string | null;
  name: string;
  notes: string | null;
}

interface AllProgramIdsResponse {
  grants: GrantRow[];
  total: number;
}

interface BatchUpdateResult {
  updated: number;
}

// ---------------------------------------------------------------------------
// Source detection from grant URL
// ---------------------------------------------------------------------------

/**
 * Detect the grant source ID from its source URL.
 * Grants in the DB store the source URL, not the source ID used during import.
 */
function detectSource(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  const url = sourceUrl.toLowerCase();

  if (url.includes("coefficientgiving.org") || url.includes("openphilanthropy.org"))
    return "coefficient-giving";
  if (url.includes("effectivealtruism.org/grants") || url.includes("funds.effectivealtruism.org"))
    return "ea-funds";
  if (url.includes("survivalandflourishing"))
    return "sff";
  if (url.includes("ftxfuturefund") || url.includes("web.archive.org") && url.includes("ftx"))
    return "ftx-future-fund";
  if (url.includes("manifund.org"))
    return "manifund";
  if (url.includes("givewell.org"))
    return "givewell";
  if (url.includes("astralcodexten"))
    return "acx-grants";

  return null;
}

/**
 * Extract focusArea-like information from grant notes.
 * EA Funds grants have the fund name in notes (e.g. "[Long-Term Future Fund] ...")
 * Coefficient Giving grants have the focus area in notes (e.g. "[Potential Risks from Advanced AI] ...")
 * FTX grants may have "regrant" in their focusArea stored in notes.
 */
function extractFocusArea(notes: string | null): string | null {
  if (!notes) return null;

  // Try to extract bracketed prefix: "[Focus Area] description"
  const bracketMatch = notes.match(/^\[([^\]]+)\]/);
  if (bracketMatch) return bracketMatch[1];

  return null;
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

  // 1. Fetch all grants with program-related fields
  console.log(`Fetching grants from ${serverUrl}...`);
  const result = await batchedRequest<AllProgramIdsResponse>(
    "GET",
    "/api/grants/all-program-ids"
  );

  if (!result.ok) {
    throw new Error(`Failed to fetch grants: ${result.message}`);
  }

  const allGrants = result.data.grants;
  console.log(`  Total grants: ${allGrants.length}\n`);

  // 2. Categorize grants
  const alreadyLinked: GrantRow[] = [];
  const noProgram: GrantRow[] = [];

  for (const grant of allGrants) {
    if (grant.programId) {
      alreadyLinked.push(grant);
    } else {
      noProgram.push(grant);
    }
  }

  console.log("=== Grant Categorization ===");
  console.log(`  Already linked (programId set):  ${alreadyLinked.length}`);
  console.log(`  No programId (to match):         ${noProgram.length}\n`);

  // 3. Match grants to programs
  const matched: Array<{ id: string; programId: string; source: string }> = [];
  const unmatchedBySource = new Map<string, number>();
  const matchedByProgram = new Map<string, number>();

  for (const grant of noProgram) {
    const source = detectSource(grant.source);
    const focusArea = extractFocusArea(grant.notes);

    const programId = matchProgram({
      source: source || "",
      funderId: grant.organizationId,
      focusArea,
      name: grant.name,
      description: grant.notes,
    });

    if (programId) {
      matched.push({ id: grant.id, programId, source: source || "unknown" });
      matchedByProgram.set(
        programId,
        (matchedByProgram.get(programId) || 0) + 1
      );
    } else {
      const src = source || "unknown";
      unmatchedBySource.set(src, (unmatchedBySource.get(src) || 0) + 1);
    }
  }

  console.log("=== Matching Results ===");
  console.log(`  Newly matched:    ${matched.length}`);
  console.log(`  Still unmatched:  ${noProgram.length - matched.length}\n`);

  // 4. Show matches by program
  if (matchedByProgram.size > 0) {
    // Reverse lookup program names from PROGRAM_IDS
    const idToLabel = new Map<string, string>();
    for (const [key, val] of Object.entries(PROGRAM_IDS)) {
      idToLabel.set(val, key);
    }

    console.log("Matches by program:");
    const sortedPrograms = [...matchedByProgram.entries()].sort(
      (a, b) => b[1] - a[1]
    );
    for (const [progId, count] of sortedPrograms) {
      const label = idToLabel.get(progId) || progId;
      console.log(`  ${count.toString().padStart(5)}x  ${label} (${progId})`);
    }
    console.log("");
  }

  // 5. Show unmatched by source
  if (unmatchedBySource.size > 0) {
    console.log("Unmatched by source:");
    const sorted = [...unmatchedBySource.entries()].sort(
      (a, b) => b[1] - a[1]
    );
    for (const [src, count] of sorted) {
      console.log(`  ${count.toString().padStart(5)}x  ${src}`);
    }
    console.log("");
  }

  // 6. Apply updates
  if (matched.length === 0) {
    console.log("No grants to update.");
    return;
  }

  if (dryRun) {
    console.log(
      `Dry run — would update ${matched.length} grants. Use without --dry-run to apply.`
    );
    return;
  }

  console.log(`Updating ${matched.length} grants...`);

  let totalUpdated = 0;
  let failedBatches = 0;

  for (let i = 0; i < matched.length; i += BATCH_SIZE) {
    const batch = matched.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(matched.length / BATCH_SIZE);

    console.log(
      `  Batch ${batchNum}/${totalBatches}: ${batch.length} grants...`
    );

    const updateResult = await batchedRequest<BatchUpdateResult>(
      "PATCH",
      "/api/grants/batch-update-program",
      {
        items: batch.map((m) => ({ id: m.id, programId: m.programId })),
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
Backfill Program IDs — Link existing grants to funding programs

Commands:
  run                  Run the backfill (default)
  run --dry-run        Preview matches without writing

This command:
  1. Fetches all grants from the wiki-server
  2. Identifies grants where programId is null
  3. Detects the grant source from the source URL
  4. Runs the program matcher (source + funder + focusArea rules)
  5. Updates matched grants with the funding program ID
  6. Reports unmatched grants by source

The matching uses the same rules as the import pipeline, ensuring
consistency between new imports and backfilled grants.
`;
}
