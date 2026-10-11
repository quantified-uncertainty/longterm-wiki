/**
 * People who must not appear anywhere on the public site.
 *
 * This is a stopgap for removal requests: the authoritative fix is deleting
 * the person's PG rows (entity + personnel) via the wiki-server API, but that
 * needs prod credentials. Until then this list keeps them off the site:
 * - build-data drops personnel rows that reference them
 * - /people/[slug] returns 404 for them (including the runtime
 *   wiki-server fallback for PG-only entities)
 *
 * Once the PG rows are deleted, an entry here can be removed.
 */

/** Person entity slugs (the `/people/<slug>` path segment). */
export const HIDDEN_PERSON_SLUGS: ReadonlySet<string> = new Set([
  "olivia-jimenez",
  "ben-hoskin",
]);

/** Display names, matched case-insensitively with punctuation and spacing normalized. */
const HIDDEN_PERSON_NAMES = [
  "Olivia Jimenez",
  "Olivia G. Jimenez",
  "Ben Hoskin",
  "Benjamin Hoskin",
];

function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const HIDDEN_NAME_SET = new Set(HIDDEN_PERSON_NAMES.map(normalizeName));

/** True if any of the given slugs or names identifies a hidden person. */
export function isHiddenPerson(
  ...candidates: Array<string | null | undefined>
): boolean {
  for (const c of candidates) {
    if (!c) continue;
    const value = c.startsWith("new:") ? c.slice(4) : c;
    if (HIDDEN_PERSON_SLUGS.has(value)) return true;
    if (HIDDEN_NAME_SET.has(normalizeName(value))) return true;
  }
  return false;
}
