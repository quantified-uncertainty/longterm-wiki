/**
 * @longterm-wiki/id-utils — Canonical ID detection for the longterm-wiki system.
 *
 * Entity stableIds use the `sid_` prefix (e.g., `sid_1LcLlMGLbw`).
 * This makes them trivially distinguishable from slugs, names, and other strings.
 *
 * The entire ID detection API is:
 *   isSid(s)             — is this a sid_-prefixed entity stableId?
 *   isDisplayableName(s) — is this safe to show to users? (inverse of isSid)
 *   generateSid()        — create a new sid_-prefixed stableId
 */

import { randomBytes } from "crypto";

// ── Constants ──────────────────────────────────────────────────────────

/** The prefix for all entity stableIds. */
export const SID_PREFIX = "sid_";

// ── Core API ───────────────────────────────────────────────────────────

/** Is this a sid_-prefixed entity stableId? */
export function isSid(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(SID_PREFIX);
}

/** Is this safe to show to users? (Not a machine-generated ID) */
export function isDisplayableName(s: string | null | undefined): boolean {
  return typeof s === "string" && !isSid(s);
}

/**
 * Generate a new sid_-prefixed stableId.
 * Format: sid_ + 10 alphanumeric characters.
 * Total length: 14 characters.
 */
export function generateSid(): string {
  return SID_PREFIX + randomAlphanumeric10();
}

// ── Internal ───────────────────────────────────────────────────────────

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomAlphanumeric10(): string {
  const bytes = randomBytes(10);
  let result = "";
  for (let i = 0; i < 10; i++) {
    result += ALPHANUMERIC[bytes[i] % ALPHANUMERIC.length];
  }
  return result;
}
