/**
 * Backward-compatible re-exports from split modules.
 *
 * The original checkers.ts has been split into:
 *   - strategies.ts — domain classification + individual check strategies
 *   - batch.ts — concurrent URL checking with rate limiting
 *   - archive.ts — archive.org snapshot lookup
 *
 * Only the original public API is re-exported here.
 */

export { checkUrlsBatch } from './batch.ts';
export { lookupArchiveForBroken } from './archive.ts';
