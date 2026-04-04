/**
 * Slug generation utilities.
 *
 * Mirrors crux/tablebase/types.ts:toSlug() for use in the Next.js app.
 * Used to generate fallback slugs when API or PG entities have non-slug IDs
 * (e.g., stableId placeholders from entity sync).
 */

/**
 * Convert a display title/name to a URL-safe slug.
 * Transliterates Unicode (e.g., u with umlaut becomes u, n with tilde becomes n).
 *
 * @example titleToSlug("Glen Weyl") // "glen-weyl"
 * @example titleToSlug("Helene Landemore") // "helene-landemore"
 */
export function titleToSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
