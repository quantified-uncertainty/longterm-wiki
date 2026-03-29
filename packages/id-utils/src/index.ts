/**
 * @longterm-wiki/id-utils — Canonical ID detection for the longterm-wiki system.
 *
 * Entity stableIds use the `sid_` prefix (e.g., `sid_1LcLlMGLbw`).
 * This makes them trivially distinguishable from slugs, names, and other strings.
 *
 * The entire ID detection API is:
 *   isSid(s)           — is this a sid_-prefixed entity stableId?
 *   isDisplayableName(s) — is this safe to show to users? (inverse of isSid)
 *   generateSid()      — create a new sid_-prefixed stableId
 *
 * Legacy support (for migration period only):
 *   isLegacyStableId(s) — detects old bare 10-char IDs without sid_ prefix
 *   isAnySid(s)         — detects both new (sid_) and legacy (bare) formats
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
  if (!s) return false;
  return !isSid(s);
}

/**
 * Generate a new sid_-prefixed stableId.
 * Format: sid_ + 10 alphanumeric characters.
 * Total length: 14 characters.
 */
export function generateSid(): string {
  return SID_PREFIX + randomAlphanumeric10();
}

// ── Legacy Support (migration period) ──────────────────────────────────

/**
 * Detects old-format bare 10-char alphanumeric stableIds (without sid_ prefix).
 * Requires at least one uppercase letter to avoid false positives on 10-char
 * lowercase slugs like "bioweapons" or "conjecture".
 * Use during migration period only. After migration completes, this can be removed.
 */
export function isLegacyStableId(s: string | null | undefined): boolean {
  return typeof s === "string" && /^(?=.*[A-Z])[A-Za-z0-9]{10}$/.test(s);
}

/**
 * Detects stableIds in either new (sid_) or legacy (bare 10-char) format.
 * Use during migration period for code that needs to handle both.
 */
export function isAnySid(s: string | null | undefined): boolean {
  return isSid(s) || isLegacyStableId(s);
}

/**
 * Legacy patterns — exported for backward compatibility during migration.
 * Prefer isSid() for new code.
 * @deprecated Use isSid() instead
 */
export const STABLE_ID_PATTERN = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

/**
 * @deprecated Use isSid() instead — numeric PKs will be migrated away
 */
export const NUMERIC_ID_PATTERN = /^\d+$/;

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
