/**
 * Key Persons Import
 *
 * Extracts key-persons records from org YAML files in packages/kb/data/things/
 * and syncs them to the wiki-server personnel PG table.
 *
 * The YAML key-persons entries use slugs for the `person` field (e.g., "dario-amodei"),
 * while PG stores canonical entity IDs (10-char hashes). This module resolves
 * slugs to entity IDs during extraction using the KB graph.
 */

import { loadGraphFull, type LoadedKB } from './kb-loader.ts';
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
 */
export async function extractKeyPersons(): Promise<{
  records: ExtractedKeyPerson[];
  unresolved: Array<{ orgSlug: string; personSlug: string; yamlKey: string }>;
}> {
  const kb = await loadGraphFull();
  const { graph, filenameMap, idByFilename } = kb;

  const records: ExtractedKeyPerson[] = [];
  const unresolved: Array<{ orgSlug: string; personSlug: string; yamlKey: string }> = [];

  // Scan all entities for key-persons collections
  for (const entity of graph.getAllEntities()) {
    const keyPersonEntries = graph.getRecords(entity.id, 'key-persons');
    if (keyPersonEntries.length === 0) continue;

    const orgSlug = filenameMap.get(entity.id) ?? entity.id;

    for (const entry of keyPersonEntries) {
      const personSlug = typeof entry.fields.person === 'string'
        ? entry.fields.person
        : String(entry.fields.person ?? '');

      // Resolve slug to entity ID via filename map
      let personEntityId: string | null = null;
      // If the value is already a 10-char entity ID, use it directly
      if (personSlug.length === 10 && graph.getEntity(personSlug)) {
        personEntityId = personSlug;
      } else {
        // Resolve as a slug/filename
        personEntityId = idByFilename.get(personSlug) ?? null;
      }

      if (!personEntityId) {
        unresolved.push({ orgSlug, personSlug, yamlKey: entry.key });
      }

      records.push({
        yamlKey: entry.key,
        orgSlug,
        orgEntityId: entity.id,
        personSlug,
        personEntityId,
        title: String(entry.fields.title ?? ''),
        startDate: entry.fields.start ? String(entry.fields.start) : null,
        endDate: entry.fields.end ? String(entry.fields.end) : null,
        isFounder: entry.fields.is_founder === true,
        source: entry.fields.source ? String(entry.fields.source) : null,
        notes: entry.fields.notes ? String(entry.fields.notes) : null,
      });
    }
  }

  return { records, unresolved };
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
