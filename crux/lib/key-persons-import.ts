/**
 * Key Persons Import
 *
 * Previously extracted key-persons records from org YAML files in packages/factbase/data/things/
 * and synced them to the wiki-server personnel PG table.
 *
 * DEPRECATED: Records have been migrated from KB YAML to PostgreSQL.
 * The extractKeyPersons() function now returns empty results.
 * Key persons data should be read from the wiki-server /api/personnel endpoint.
 */

import { generateId } from './grant-import/id.ts';
import { apiRequest, getServerUrl } from './wiki-server/client.ts';

// ── Types ────────────────────────────────────────────────────────────

export interface KeyPersonSyncItem {
  id: string;
  personId: string;
  organizationId: string;
  role: string;
  roleType: 'key-person';
  startDate: string | null;
  endDate: string | null;
  isFounder: boolean;
  source: string | null;
  notes: string | null;
}

export interface ExtractedKeyPerson {
  /** YAML key within the key-persons collection (e.g., "dario-amodei") */
  yamlKey: string;
  /** Org slug (YAML filename, e.g., "anthropic") */
  orgSlug: string;
  /** Resolved org entity ID (10-char) */
  orgEntityId: string;
  /** Person slug from the `person` field */
  personSlug: string;
  /** Resolved person entity ID (10-char), or null if unresolved */
  personEntityId: string | null;
  /** Role title */
  title: string;
  startDate: string | null;
  endDate: string | null;
  isFounder: boolean;
  source: string | null;
  notes: string | null;
}

// ── Extraction ───────────────────────────────────────────────────────

/**
 * Extract all key-persons records from the KB graph.
 * Resolves person slugs to entity IDs using the graph's filename map.
 *
 * @deprecated Records (including key-persons) have been migrated from KB YAML
 * to PostgreSQL. Use the wiki-server /api/personnel endpoint instead.
 */
export async function extractKeyPersons(): Promise<{
  records: ExtractedKeyPerson[];
  unresolved: Array<{ orgSlug: string; personSlug: string; yamlKey: string }>;
}> {
  // DEPRECATED: Records (including key-persons) have been migrated from KB YAML
  // to PostgreSQL. graph.getRecords() no longer exists. Key persons data should
  // now be read directly from the wiki-server personnel table instead.
  console.warn(
    '[key-persons-import] extractKeyPersons() is deprecated — records are now in PG, not KB YAML. ' +
    'Use the wiki-server /api/personnel endpoint instead.',
  );
  return { records: [], unresolved: [] };
}

// ── Conversion to sync items ─────────────────────────────────────────

/**
 * Convert extracted key-persons to personnel sync items.
 * Only includes records where the person entity ID was resolved.
 */
export function toSyncItems(records: ExtractedKeyPerson[]): KeyPersonSyncItem[] {
  return records
    .filter((r): r is ExtractedKeyPerson & { personEntityId: string } =>
      r.personEntityId !== null && r.title.length > 0)
    .map((r) => {
      // Deterministic ID: org + person + role type
      const idInput = `key-person|${r.orgEntityId}|${r.personEntityId}|${r.yamlKey}`;
      const id = generateId(idInput);

      return {
        id,
        personId: r.personEntityId,
        organizationId: r.orgEntityId,
        role: r.title.substring(0, 500),
        roleType: 'key-person' as const,
        startDate: r.startDate,
        endDate: r.endDate,
        isFounder: r.isFounder,
        source: r.source?.substring(0, 2000) ?? null,
        notes: r.notes?.substring(0, 5000) ?? null,
      };
    });
}

// ── Sync to wiki-server ──────────────────────────────────────────────

const SYNC_BATCH_SIZE = 500;

/**
 * Sync key-persons items to the wiki-server personnel table.
 * Supports dry-run mode (no data written).
 */
export async function syncKeyPersons(
  items: KeyPersonSyncItem[],
  dryRun: boolean,
): Promise<{ upserted: number; failed: number }> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    throw new Error(
      'wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod.',
    );
  }

  console.log(`\nSyncing ${items.length} key-persons to ${serverUrl}...`);

  if (dryRun) {
    console.log('  (dry run -- no data written)');
    console.log(`  Would send ${Math.ceil(items.length / SYNC_BATCH_SIZE)} batch(es) of up to ${SYNC_BATCH_SIZE}`);
    return { upserted: 0, failed: 0 };
  }

  let totalUpserted = 0;
  let failedBatches = 0;

  for (let i = 0; i < items.length; i += SYNC_BATCH_SIZE) {
    const batch = items.slice(i, i + SYNC_BATCH_SIZE);
    const batchNum = Math.floor(i / SYNC_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(items.length / SYNC_BATCH_SIZE);

    console.log(`  Batch ${batchNum}/${totalBatches}: ${batch.length} items...`);

    const result = await apiRequest<{ upserted: number }>(
      'POST',
      '/api/personnel/sync',
      { items: batch },
    );

    if (result.ok) {
      totalUpserted += result.data.upserted;
      console.log(`    -> ${result.data.upserted} upserted`);
    } else {
      failedBatches++;
      console.error(`    Failed: ${result.message}`);
    }
  }

  return { upserted: totalUpserted, failed: failedBatches };
}
