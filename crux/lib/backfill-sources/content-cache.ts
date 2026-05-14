/**
 * On-disk cache of every page text that was ever sent to a judge during a
 * backfill-sources run. The candidate record stores only the sha256; the
 * actual bytes are written here so a single candidate can be replayed
 * byte-for-byte after the run by reading the file at
 * `<dir>/<sha256>.txt`.
 *
 * Default location: `dev/backfill-content-cache/`. Override with
 * `BACKFILL_CONTENT_CACHE_DIR=<path>`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DIR = 'dev/backfill-content-cache';

let _cacheDir: string | null = null;
function cacheDir(): string {
  if (_cacheDir !== null) return _cacheDir;
  _cacheDir = process.env.BACKFILL_CONTENT_CACHE_DIR ?? DEFAULT_DIR;
  mkdirSync(_cacheDir, { recursive: true });
  return _cacheDir;
}

/**
 * Hash + persist `text`. Returns the sha256. Idempotent: if a file at the
 * sha256 path already exists we skip the write. Writes are best-effort —
 * a write failure logs a warning but does not throw, since the run can
 * continue without the cache (the hash is still recorded in the report).
 */
export function rememberContent(text: string): string {
  const sha = createHash('sha256').update(text).digest('hex');
  const path = join(cacheDir(), `${sha}.txt`);
  if (!existsSync(path)) {
    try {
      writeFileSync(path, text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[content-cache] write failed for ${sha.slice(0, 8)}: ${msg}`);
    }
  }
  return sha;
}
