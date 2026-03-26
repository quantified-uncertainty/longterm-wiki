import { createHash } from "crypto";

/**
 * Characters used to replace `-` and `_` from base64url output,
 * producing IDs that are strictly alphanumeric [0-9a-zA-Z].
 *
 * The replacement is deterministic: `-` (charCode 45) always maps to '9',
 * `_` (charCode 95) always maps to 'n'. This means existing clean IDs
 * are unchanged, but IDs that previously contained `-`/`_` will differ.
 */
const REPLACEMENT_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Generate a deterministic 10-char alphanumeric ID from input string.
 *
 * Uses SHA-256 hash → base64url → strip `-`/`_` to match the canonical
 * stableId format used by packages/factbase/src/ids.ts.
 */
export function generateId(input: string): string {
  const hash = createHash("sha256").update(input).digest("base64url");
  return hash.substring(0, 10).replace(/[-_]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return REPLACEMENT_CHARS[code % REPLACEMENT_CHARS.length];
  });
}
