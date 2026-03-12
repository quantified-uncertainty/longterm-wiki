import { generateId } from "./id.ts";
import type { RawGrant, SyncGrant } from "./types.ts";
import { apiRequest, getServerUrl } from "../wiki-server/client.ts";

export const SYNC_BATCH_SIZE = 500;

/**
 * Convert a RawGrant to a SyncGrant.
 * The defaultSourceUrl is used unless the raw grant has its own sourceUrl (e.g. Manifund).
 */
export function toSyncGrant(raw: RawGrant, defaultSourceUrl: string): SyncGrant {
  // Generate deterministic ID from source + funder + grantee + date + amount
  const idInput = `${raw.source}|${raw.funderId}|${raw.granteeName}|${raw.date || ""}|${raw.amount || ""}|${raw.name.substring(0, 100)}`;
  const id = generateId(idInput);

  // granteeId: always store the human-readable name (max 200 chars).
  // The entity stableId is useful for linking but the grants table renders
  // this field directly, so it must always be a display name.
  const granteeId = raw.granteeName.substring(0, 200);

  // Truncate notes
  let notes: string | null = null;
  if (raw.focusArea && raw.description) {
    notes = `[${raw.focusArea}] ${raw.description}`.substring(0, 5000);
  } else if (raw.focusArea) {
    notes = raw.focusArea;
  } else if (raw.description) {
    notes = raw.description.substring(0, 5000);
  }

  return {
    id,
    organizationId: raw.funderId,
    granteeId,
    name: raw.name,
    amount: raw.amount,
    currency: "USD",
    date: raw.date,
    status: null,
    source: raw.sourceUrl ?? defaultSourceUrl,
    notes,
  };
}

export async function syncToServer(
  grants: SyncGrant[],
  dryRun: boolean,
): Promise<void> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    console.error(
      "ERROR: wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
    process.exit(1);
  }

  console.log(`\nSyncing ${grants.length} grants to ${serverUrl}...`);

  if (dryRun) {
    console.log("  (dry run — no data written)");
    console.log(`  Would send ${Math.ceil(grants.length / SYNC_BATCH_SIZE)} batches of up to ${SYNC_BATCH_SIZE}`);
    return;
  }

  let totalUpserted = 0;
  let failedBatches = 0;
  for (let i = 0; i < grants.length; i += SYNC_BATCH_SIZE) {
    const batch = grants.slice(i, i + SYNC_BATCH_SIZE);
    const batchNum = Math.floor(i / SYNC_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(grants.length / SYNC_BATCH_SIZE);

    console.log(
      `  Batch ${batchNum}/${totalBatches}: ${batch.length} grants...`
    );

    const result = await apiRequest<{ upserted: number }>(
      "POST",
      "/api/grants/sync",
      { items: batch },
    );

    if (result.ok) {
      totalUpserted += result.data.upserted;
      console.log(`    → ${result.data.upserted} upserted`);
    } else {
      failedBatches++;
      console.error(`    ✗ Batch ${batchNum} failed:`, result.error);
    }
  }

  console.log(`\nTotal upserted: ${totalUpserted}`);
  if (failedBatches > 0) {
    throw new Error(`${failedBatches} grant sync batch(es) failed`);
  }
}
