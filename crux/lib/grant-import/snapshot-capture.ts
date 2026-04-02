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

/**
 * Register data source and capture a snapshot for a grant source.
 * Skips silently if no manifest or cache file exists.
 * Fire-and-forget: errors are logged but don't block the import.
 */
export async function captureSourceSnapshot(sourceId: string): Promise<{ ok: boolean; error?: string }> {
  const manifest = getManifest(sourceId);
  if (!manifest || !manifest.cachePath) return { ok: false, error: 'no manifest or cachePath' };
  if (!existsSync(manifest.cachePath)) {
    console.log(`  [snapshot] No cache file at ${manifest.cachePath}, skipping snapshot`);
    return { ok: false, error: `no cache file at ${manifest.cachePath}` };
  }

  try {
    // Read raw content
    const rawContent = readFileSync(manifest.cachePath, 'utf8');
    if (!rawContent || rawContent.length === 0) {
      console.log(`  [snapshot] Empty cache file for ${sourceId}, skipping`);
      return { ok: false, error: 'empty cache file' };
    }

    // Hash for dedup
    const snapshotHash = createHash('sha256').update(rawContent).digest('hex').slice(0, 64);

    // Count records (rough estimate from line count for CSVs)
    let recordCount: number | null = null;
    if (manifest.format === 'csv') {
      recordCount = rawContent.split('\n').filter(l => l.trim()).length - 1; // subtract header
    } else if (manifest.format === 'json_api') {
      try {
        const parsed = JSON.parse(rawContent);
        recordCount = Array.isArray(parsed) ? parsed.length : null;
      } catch { /* ignore parse errors for counting */ }
    }

    // Register/update the data source
    const dsResult = await syncDataSource({
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
      const msg = `Failed to sync data source ${sourceId}: ${dsResult.error}`;
      console.warn(`  [snapshot] ${msg}`);
      return { ok: false, error: msg };
    }

    // Store snapshot (dedup by hash — no-op if content unchanged)
    const snapResult = await createSnapshot(manifest.sourceId, {
      snapshotHash,
      rawContent,
      recordCount,
      parserVersion: '1',
    });

    if (snapResult.ok) {
      const data = snapResult.data as { deduplicated?: boolean; id?: number };
      if (data.deduplicated) {
        console.log(`  [snapshot] ${sourceId}: content unchanged (hash dedup)`);
      } else {
        console.log(`  [snapshot] ${sourceId}: new snapshot stored (${recordCount ?? '?'} records, ${(rawContent.length / 1024).toFixed(0)}KB)`);
      }
      return { ok: true };
    } else {
      const msg = `Failed to store snapshot for ${sourceId}: ${snapResult.error}`;
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
 */
export async function captureAllSnapshots(sourceIds: string[]): Promise<{ succeeded: number; failed: number }> {
  console.log('\nCapturing source snapshots...');
  let succeeded = 0;
  let failed = 0;
  for (const id of sourceIds) {
    const result = await captureSourceSnapshot(id);
    if (result.ok) {
      succeeded++;
    } else {
      failed++;
    }
  }
  console.log(`Snapshot capture complete: ${succeeded} succeeded, ${failed} failed`);
  return { succeeded, failed };
}
