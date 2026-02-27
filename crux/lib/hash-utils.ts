/**
 * Hash Utilities
 *
 * Simple hash functions for generating IDs and detecting content changes.
 * Previously lived in knowledge-db.ts alongside the SQLite DAOs.
 */

import { createHash } from 'crypto';

/**
 * Generate a 16-character hex hash ID from a URL or other string.
 * Used for source ID generation and deduplication keys.
 */
export function hashId(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Get an MD5 content hash for change detection.
 * Used by scan-content to skip unchanged MDX files.
 */
export function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex');
}
