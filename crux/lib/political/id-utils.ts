/**
 * Shared deterministic ID generation for political data modules.
 *
 * Produces a 10-character alphanumeric ID by SHA-256 hashing a colon-joined
 * key string and taking the first 10 characters of the base64url digest,
 * with `-` and `_` replaced by alphanumeric characters.
 *
 * Used by: fec.ts, scorecard-ingest.ts, votes-ingest.ts
 */

import { createHash } from "node:crypto";

const REPLACEMENT_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Generate a deterministic 10-char alphanumeric ID from a prefix and key parts.
 *
 * The input string is `prefix:part1:part2:...` hashed with SHA-256, encoded as
 * base64url, truncated to 10 characters, with `-` and `_` replaced.
 *
 * @example
 * generateDeterministicId("campaign-finance", candidateKey, cycle)
 * generateDeterministicId("political-score", org, name, year)
 */
export function generateDeterministicId(
  prefix: string,
  ...keyParts: (string | number)[]
): string {
  const input = [prefix, ...keyParts].join(":");
  const hash = createHash("sha256").update(input).digest("base64url");
  return hash.substring(0, 10).replace(/[-_]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return REPLACEMENT_CHARS[code % REPLACEMENT_CHARS.length];
  });
}
