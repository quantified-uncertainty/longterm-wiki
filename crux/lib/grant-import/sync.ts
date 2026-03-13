import { generateId } from "./id.ts";
import { isSupportedCurrency } from "./currency.ts";
import type { RawGrant, SyncGrant } from "./types.ts";
import { apiRequest, getServerUrl } from "../wiki-server/client.ts";

export const SYNC_BATCH_SIZE = 500;

/** Normalize and validate currency code, defaulting to USD. */
function validateCurrency(currency: string | undefined): string {
  const normalized = (currency ?? "USD").trim().toUpperCase();
  if (!isSupportedCurrency(normalized)) {
    if (currency) {
      console.warn(`Unsupported currency "${currency}", defaulting to USD`);
    }
    return "USD";
  }
  return normalized;
}

/**
 * Convert a RawGrant to a SyncGrant.
 * The defaultSourceUrl is used unless the raw grant has its own sourceUrl (e.g. Manifund).
 */
export function toSyncGrant(raw: RawGrant, defaultSourceUrl: string): SyncGrant {
  // Generate deterministic ID from source + funder + grantee + date + amount
  const idInput = `${raw.source}|${raw.funderId}|${raw.granteeName}|${raw.date || ""}|${raw.amount || ""}|${raw.name.substring(0, 100)}`;
  const id = generateId(idInput);

  // Use the matched entity stableId when available; fall back to display name.
  // This allows the grants table to link grantees to their entity pages.
  const granteeId = (raw.granteeId ?? raw.granteeName).substring(0, 200);

  // Truncate notes
  let notes: string | null = null;
  if (raw.focusArea && raw.description) {
    notes = `[${raw.focusArea}] ${raw.description}`.substring(0, 5000);
  } else if (raw.focusArea) {
    notes = raw.focusArea.substring(0, 5000);
  } else if (raw.description) {
    notes = raw.description.substring(0, 5000);
  }

  return {
    id,
    organizationId: raw.funderId,
    granteeId,
    name: raw.name,
    amount: raw.amount,
    currency: validateCurrency(raw.currency),
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
    throw new Error(
      "wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod."
    );
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
