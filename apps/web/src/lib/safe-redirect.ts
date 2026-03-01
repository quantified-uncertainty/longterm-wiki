/**
 * Validate that a redirect target is safe (same-origin, relative path).
 *
 * Prevents open-redirect attacks where an attacker crafts a login URL like:
 *   /login?from=https://evil.com
 *   /login?from=%2F%2Fevil.com   (URL-encoded //evil.com)
 *   /login?from=/\evil.com       (backslash trick)
 *
 * This module has no server dependencies and can be used in both
 * client components and Edge Runtime middleware.
 */

/**
 * Returns true if the given path is a safe same-origin redirect target.
 *
 * Safe means:
 * - Starts with a single "/" (relative path)
 * - Does not start with "//" (protocol-relative URL)
 * - Does not contain backslashes (which some browsers treat as forward slashes)
 * - Does not contain CRLF characters (header injection)
 * - After URL decoding, still satisfies all the above rules
 *
 * @param path - The redirect target to validate
 * @returns true if the path is safe to redirect to
 */
export function isSafeRedirect(path: string): boolean {
  if (!path || typeof path !== "string") return false;

  // Decode the path to catch URL-encoded bypass attempts
  let decoded: string;
  try {
    // Decode iteratively to handle double-encoding
    decoded = path;
    let prev = "";
    let iterations = 0;
    while (decoded !== prev && iterations < 5) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
      iterations++;
    }
  } catch {
    // If decoding fails (e.g., malformed %XX), reject
    return false;
  }

  // Check both the original and decoded versions
  for (const p of [path, decoded]) {
    // Must start with exactly one forward slash
    if (!p.startsWith("/")) return false;

    // Reject protocol-relative URLs (//evil.com)
    if (p.startsWith("//")) return false;

    // Reject backslashes (some browsers normalize \ to /)
    if (p.includes("\\")) return false;

    // Reject CRLF (header injection)
    if (p.includes("\r") || p.includes("\n")) return false;

    // Reject @ in authority position (//@evil.com or /foo@evil.com before first /)
    // This catches edge cases like //user@evil.com
    if (p.startsWith("/@") || p.startsWith("//@")) return false;
  }

  return true;
}

/**
 * Return the redirect path if it's safe, or a fallback otherwise.
 */
export function safeRedirectOr(path: string | null | undefined, fallback: string): string {
  if (path && isSafeRedirect(path)) return path;
  return fallback;
}
