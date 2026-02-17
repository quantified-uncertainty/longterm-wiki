/**
 * API Key Utilities
 *
 * Handles reading and sanitizing API keys from environment variables.
 * Environment variables sometimes contain embedded quotes (e.g. when set
 * via certain CI systems or .env file parsers), which causes auth failures.
 */

/**
 * Read an API key from process.env, stripping any surrounding quotes and whitespace.
 * Returns undefined if the key is not set or empty after cleaning.
 */
export function getApiKey(envVar: string): string | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;

  // Strip surrounding quotes (single or double) and whitespace
  const cleaned = raw.replace(/^["'\s]+|["'\s]+$/g, '');
  return cleaned || undefined;
}
