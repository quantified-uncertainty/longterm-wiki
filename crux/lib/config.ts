/**
 * Centralized configuration constants for the crux CLI.
 *
 * Timeout values that are shared across multiple modules live here
 * to prevent drift between duplicated constants.
 */

// ---------------------------------------------------------------------------
// Wiki-server timeouts
// ---------------------------------------------------------------------------

/** Default timeout for individual wiki-server API requests (ms). */
export const WIKI_SERVER_TIMEOUT_MS = 5_000;

/** Timeout for batched wiki-server requests (ms). */
export const WIKI_SERVER_BATCH_TIMEOUT_MS = 30_000;

/** Health check timeout for wiki-server probes (ms). */
export const WIKI_SERVER_HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Delay between health check retries (ms). */
export const WIKI_SERVER_HEALTH_CHECK_DELAY_MS = 10_000;
