/**
 * Heuristic entity-reference detection for FactBase values.
 *
 * When schema field definitions are unavailable, we need a way to decide
 * whether a raw string value should be rendered as an entity link (e.g.,
 * "anthropic" -> Anthropic entity page) or as plain text (e.g., "Board Member").
 *
 * The heuristics:
 *  1. sid_-prefixed IDs are always entity references.
 *  2. Single-word/hyphenated strings (no spaces, not URLs) that resolve to a
 *     known FactBase entity are treated as references.
 *  3. Everything else (prose, URLs, numbers-as-text, etc.) is left as-is.
 *
 * Used by FBCellValue (table cells) and the record detail page.
 */

import { isSid } from "@longterm-wiki/id-utils";
import { isUrl } from "./format";

/** FactBase entity IDs are exactly 10 alphanumeric characters (legacy format). */
const ENTITY_ID_RE = /^[A-Za-z0-9]{10}$/;

/**
 * EntityResolver is the signature for looking up an entity by ID or slug.
 * Returns a truthy value (the entity object) if found, undefined otherwise.
 * This abstraction lets us inject a mock in tests without importing the
 * full data layer.
 */
export type EntityResolver = (idOrSlug: string) => unknown;

/**
 * Determine whether a string value should be rendered as an entity reference
 * link, given an optional schema field type and an entity resolver function.
 *
 * When `fieldType` is `"ref"`, always returns true (schema-confirmed reference).
 * When `fieldType` is absent (no schema), applies heuristics:
 *   - Must not contain spaces (prose/descriptions always have spaces)
 *   - Must not be a URL (http:// or https://)
 *   - Must be a sid_-prefixed ID, or resolve as a known FactBase entity
 */
export function shouldResolveAsRef(
  value: string,
  fieldType: string | undefined,
  getEntity: EntityResolver,
): boolean {
  // Schema-confirmed ref — always resolve
  if (fieldType === "ref") return true;

  // Only apply heuristics when schema is unavailable
  if (fieldType) return false;

  // Quick rejections: empty string, contains spaces, or is a URL
  if (!value || value.includes(" ") || isUrl(value)) return false;

  // sid_-prefixed IDs are always entity references
  if (isSid(value)) return true;

  // Try resolving as a known entity (legacy 10-char ID, slug, etc.)
  return getEntity(value) !== undefined;
}

/**
 * Try to resolve an arbitrary value as a FactBase entity reference.
 * Returns the resolved entity object if the value looks like an entity ref
 * and resolves to a known entity, or undefined otherwise.
 *
 * Handles:
 *   - sid_-prefixed IDs
 *   - Legacy 10-char alphanumeric IDs
 *   - Entity slugs (e.g., "anthropic", "employee-equity-pool")
 *
 * Rejects:
 *   - Non-string values (null, undefined, numbers, booleans, objects)
 *   - Strings with spaces (prose/descriptions)
 *   - URLs (http:// or https://)
 */
export function tryResolveEntityRef(
  value: unknown,
  getEntity: EntityResolver,
): unknown | undefined {
  if (typeof value !== "string") return undefined;
  if (!value || value.includes(" ") || isUrl(value)) return undefined;

  // sid_-prefixed IDs and legacy 10-char IDs always attempt resolution
  if (isSid(value) || ENTITY_ID_RE.test(value)) return getEntity(value);

  // Also try resolving as a slug (e.g., "amazon", "employee-equity-pool")
  // Exclude strings with "://" which are URLs that slipped past the isUrl check
  if (!value.includes("://")) return getEntity(value);

  return undefined;
}
