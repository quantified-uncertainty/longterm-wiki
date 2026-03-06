/**
 * Stable ID generation for the Knowledge Base library.
 *
 * - generateStableId()         — random 10-char alphanumeric (for Entity.stableId)
 * - generateFactId()           — "f_" + 10-char alphanumeric (random)
 * - contentHash(parts)         — deterministic SHA-256-based 10-char token
 * - generateContentFactId(...) — "f_" + contentHash (idempotent sync helper)
 */

import { createHash, randomBytes } from "node:crypto";

/** Characters used to replace `-` and `_` from base64url output. */
const REPLACEMENT_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Returns a clean 10-character alphanumeric string derived from
 * `crypto.randomBytes(7).toString("base64url")`, with any `-` or `_`
 * replaced by alphanumeric characters so the result is URL-safe and visually
 * consistent.
 */
function randomAlphanumeric10(): string {
  const raw = randomBytes(7).toString("base64url").slice(0, 10);
  return raw
    .split("")
    .map((ch) => {
      if (ch === "-" || ch === "_") {
        // Replace with a deterministic-looking but effectively random char by
        // drawing a fresh byte mod the replacement alphabet length.
        const byte = randomBytes(1)[0];
        return REPLACEMENT_CHARS[byte % REPLACEMENT_CHARS.length];
      }
      return ch;
    })
    .join("");
}

/**
 * Returns a random 10-character alphanumeric string suitable for use as a
 * Entity's `stableId`.  Survives renames because it is purely random.
 *
 * @example
 * generateStableId() // "a3Kf2rZ9mQ"
 */
export function generateStableId(): string {
  return randomAlphanumeric10();
}

/**
 * Returns a random fact ID: `"f_"` followed by 10 random alphanumeric chars.
 * Use this when you do not need determinism (i.e., you are creating a brand-new
 * fact that has no natural content key).
 *
 * @example
 * generateFactId() // "f_x7Nm2pA0qR"
 */
export function generateFactId(): string {
  return `f_${randomAlphanumeric10()}`;
}

/**
 * Produces a deterministic 10-character base64url token by SHA-256 hashing
 * the concatenation of `parts` (joined with a null-byte separator to prevent
 * accidental collisions between adjacent inputs).
 *
 * Same inputs always produce the same output — suitable for content-addressed
 * keys and idempotent sync operations.
 *
 * @example
 * contentHash(["anthropic", "revenue", "1000000000", "2024"])
 * // always the same 10-char string
 */
export function contentHash(parts: string[]): string {
  const combined = parts.join("\x00");
  const raw = createHash("sha256")
    .update(combined, "utf8")
    .digest("base64url")
    .slice(0, 10);
  // Normalize to same alphanumeric alphabet as randomAlphanumeric10()
  return raw.replace(/[-_]/g, (ch) => {
    // Deterministic replacement from char code
    const code = ch.charCodeAt(0);
    return REPLACEMENT_CHARS[code % REPLACEMENT_CHARS.length];
  });
}

/**
 * Generates a deterministic fact ID from its logical key components.
 * The ID is `"f_"` followed by a {@link contentHash} of
 * `[subjectId, propertyId, JSON.stringify(value), asOf ?? ""]`.
 *
 * Use this when syncing facts from an external source so that re-running the
 * sync does not create duplicates.
 *
 * @param subjectId  - Entity slug the fact is about
 * @param propertyId - Property ID from the registry
 * @param value      - The fact value (any JSON-serialisable type)
 * @param asOf       - Optional temporal anchor (ISO date or YYYY-MM string)
 *
 * @example
 * generateContentFactId("anthropic", "revenue", 1_000_000_000, "2024")
 * // "f_<10 deterministic chars>"
 */
export function generateContentFactId(
  subjectId: string,
  propertyId: string,
  value: unknown,
  asOf?: string
): string {
  return `f_${contentHash([
    subjectId,
    propertyId,
    JSON.stringify(value),
    asOf ?? "",
  ])}`;
}
