/**
 * Snapshot Capture — captures raw source content during grant import.
 *
 * Called during `import-grants sync` after ensureData() downloads the raw files.
 * Registers the data source and stores a snapshot with content-hash dedup.
 *
 * Part of Phase 2: Data Source Resources (Discussion #3567).
 */

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { syncDataSource, createSnapshot } from '../wiki-server/data-sources.ts';
import { getManifest, MANIFESTS } from './manifests/index.ts';
import { parseCSVContent, parseHTMLTable, parseJSONArray } from '../source-check/source-parsers.ts';

const RATE_LIMIT_DELAY_MS = 6_000;
const INTER_SOURCE_DELAY_MS = 2_000;
const MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimited(result: { ok: false; error: string; message: string }): number | null {
  const match = result.message.match(/retryAfter[":]\s*(\d+)/i);
  if (match) return parseInt(match[1], 10) * 1000;
  if (result.message.includes('429') || result.message.includes('rate_limit')) return RATE_LIMIT_DELAY_MS;
  return null;
}

/**
 * Register data source and capture a snapshot for a grant source.
 * Skips silently if no manifest or cache file exists.
 * Fire-and-forget: errors are logged but don't block the import.
 */
export async function captureSourceSnapshot(sourceId: string): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const manifest = getManifest(sourceId);
  if (!manifest || !manifest.cachePath) return { ok: false, skipped: true, error: 'no manifest or cachePath' };
  if (!existsSync(manifest.cachePath)) {
    console.log(`  [snapshot] No cache file at ${manifest.cachePath}, skipping snapshot`);
    return { ok: false, skipped: true, error: `no cache file at ${manifest.cachePath}` };
  }

  try {
    // Read raw content, clean up common issues:
    // - Strip BOM (gates-foundation CSV has one)
    // - Strip null bytes (gates-foundation CSV has 5MB of null padding — Postgres rejects \0 in text)
    const rawContent = readFileSync(manifest.cachePath, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\0/g, '');
    if (!rawContent || rawContent.length === 0) {
      console.log(`  [snapshot] Empty cache file for ${sourceId}, skipping`);
      return { ok: false, error: 'empty cache file' };
    }

    // Hash for dedup
    const snapshotHash = createHash('sha256').update(rawContent).digest('hex').slice(0, 64);

    // Count records using the same parsers used for deterministic matching
    let recordCount: number | null = null;
    try {
      if (manifest.format === 'csv' || manifest.format === 'spreadsheet') {
        recordCount = parseCSVContent(rawContent).length;
      } else if (manifest.format === 'json_api') {
        recordCount = parseJSONArray(rawContent).length;
      } else if (manifest.format === 'html_table') {
        recordCount = parseHTMLTable(rawContent).length;
      }
    } catch {
      // Fall back to null if parsing fails — recordCount is advisory
      recordCount = null;
    }

    // Register/update the data source (with retry on rate limit)
    let dsResult = await syncDataSource({
      id: manifest.sourceId,
      name: manifest.name,
      dataFormat: manifest.format,
      accessMethod: manifest.accessMethod,
      recordType: 'grant',
      fetchUrl: manifest.fetchUrl,
      publisherEntityId: manifest.publisherEntityId,
      updateFrequency: manifest.updateFrequency,
      columnMapping: Object.fromEntries(
        manifest.schema.fields
          .filter(f => f.internalField)
          .map(f => [f.sourceName, f.internalField!])
      ),
      verificationConfig: manifest.verification as unknown as Record<string, unknown>,
    });

    if (!dsResult.ok) {
      const retryMs = isRateLimited(dsResult);
      if (retryMs) {
        console.log(`  [snapshot] ${sourceId}: rate limited, retrying in ${retryMs / 1000}s...`);
        await sleep(retryMs);
        dsResult = await syncDataSource({
          id: manifest.sourceId, name: manifest.name, dataFormat: manifest.format,
          accessMethod: manifest.accessMethod, recordType: 'grant', fetchUrl: manifest.fetchUrl,
          publisherEntityId: manifest.publisherEntityId, updateFrequency: manifest.updateFrequency,
          columnMapping: Object.fromEntries(manifest.schema.fields.filter(f => f.internalField).map(f => [f.sourceName, f.internalField!])),
          verificationConfig: manifest.verification as unknown as Record<string, unknown>,
        });
      }
    }

    if (!dsResult.ok) {
      const msg = `Failed to sync data source ${sourceId}: ${dsResult.error}${dsResult.message ? ` — ${dsResult.message}` : ''}`;
      console.warn(`  [snapshot] ${msg}`);
      return { ok: false, error: msg };
    }

    // Store snapshot (dedup by hash — no-op if content unchanged, retry on rate limit)
    let snapResult = await createSnapshot(manifest.sourceId, {
      snapshotHash,
      rawContent,
      recordCount,
      parserVersion: '1',
    });

    if (!snapResult.ok) {
      const retryMs = isRateLimited(snapResult);
      if (retryMs) {
        console.log(`  [snapshot] ${sourceId}: rate limited, retrying in ${retryMs / 1000}s...`);
        await sleep(retryMs);
        snapResult = await createSnapshot(manifest.sourceId, { snapshotHash, rawContent, recordCount, parserVersion: '1' });
      }
    }

    if (snapResult.ok) {
      const data = snapResult.data as { deduplicated?: boolean; id?: number };
      if (data.deduplicated) {
        console.log(`  [snapshot] ${sourceId}: content unchanged (hash dedup)`);
      } else {
        console.log(`  [snapshot] ${sourceId}: new snapshot stored (${recordCount ?? '?'} records, ${(rawContent.length / 1024).toFixed(0)}KB)`);
      }
      return { ok: true };
    } else {
      const sizeMB = (rawContent.length / (1024 * 1024)).toFixed(1);
      const msg = `Failed to store snapshot for ${sourceId} (${sizeMB}MB): ${snapResult.error}${snapResult.message ? ` — ${snapResult.message}` : ''}`;
      console.warn(`  [snapshot] ${msg}`);
      return { ok: false, error: msg };
    }
  } catch (e: unknown) {
    // Best-effort — don't fail the import if snapshot capture fails
    const msg = `Error capturing snapshot for ${sourceId}: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(`  [snapshot] ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Capture snapshots for all sources that have manifests with cache files.
 * Adds inter-source delay to avoid rate limiting.
 */
export async function captureAllSnapshots(sourceIds: string[]): Promise<{ succeeded: number; failed: number; skipped: number }> {
  console.log('\nCapturing source snapshots...');
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < sourceIds.length; i++) {
    if (i > 0) await sleep(INTER_SOURCE_DELAY_MS);
    const result = await captureSourceSnapshot(sourceIds[i]);
    if (result.ok) {
      succeeded++;
    } else if (result.skipped) {
      skipped++;
    } else {
      failed++;
    }
  }
  const parts = [`${succeeded} succeeded`, `${failed} failed`];
  if (skipped > 0) parts.push(`${skipped} skipped (no manifest/cache)`);
  console.log(`Snapshot capture complete: ${parts.join(', ')}`);
  return { succeeded, failed, skipped };
}
