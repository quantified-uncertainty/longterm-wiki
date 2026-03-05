/** URL safety and parsing utilities shared across wiki components */

/**
 * Returns true only for http: and https: URLs.
 * Rejects javascript:, data:, ftp:, and any other scheme that could be
 * used for XSS or unexpected navigation when rendered as an <a> href.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
