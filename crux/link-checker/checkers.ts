/**
 * Backward-compatible re-exports from split modules.
 *
 * The original checkers.ts has been split into:
 *   - strategies.ts — domain classification + individual check strategies
 *   - batch.ts — concurrent URL checking with rate limiting
 *   - archive.ts — archive.org snapshot lookup
 */

export { checkUrlsBatch } from './batch.ts';
export { lookupArchiveForBroken } from './archive.ts';
export { checkSingleUrl, getCheckStrategy, httpCheck, getDomain } from './strategies.ts';
