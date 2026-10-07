/**
 * People who must not appear anywhere on the public site.
 *
 * This is a stopgap for removal requests: the authoritative fix is deleting
 * the person's PG rows (entity + personnel) via the wiki-server API, but that
 * needs prod credentials. Until then this list keeps them off the site:
 * - build-data drops personnel rows that reference them
 * - /people/[slug] returns 404 for them (including the runtime
 *   wiki-server fallback for PG-only entities)
 * - the public /api/* proxies scrub them from wiki-server responses
 *   (scrubHiddenPeople)
 *
 * Once the PG rows are deleted, an entry here can be removed.
 */

/** Person entity slugs (the `/people/<slug>` path segment). */
export const HIDDEN_PERSON_SLUGS: ReadonlySet<string> = new Set([
  "olivia-jimenez",
  "ben-hoskin",
  "david-field",
]);

/** PG entity ids of hidden people, for rows that reference them only by id. */
const HIDDEN_PERSON_IDS: ReadonlySet<string> = new Set([
  "zm6ciQBsFr", // Olivia Jimenez
  "5hsN7xhTbY", // Ben Hoskin
  "TFZKE3nLUb", // David Field (VARA co-founder)
]);

/** Display names, matched case-insensitively with punctuation and spacing normalized. */
const HIDDEN_PERSON_NAMES = [
  "Olivia Jimenez",
  "Olivia G. Jimenez",
  "Ben Hoskin",
  "Benjamin Hoskin",
  "David Field",
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

/** True if any of the given slugs, names or PG ids identifies a hidden person. */
export function isHiddenPerson(
  ...candidates: Array<string | null | undefined>
): boolean {
  for (const c of candidates) {
    if (!c) continue;
    const value = c.startsWith("new:") ? c.slice(4) : c;
    if (HIDDEN_PERSON_SLUGS.has(value)) return true;
    if (HIDDEN_PERSON_IDS.has(stripSid(value))) return true;
    if (HIDDEN_NAME_SET.has(normalizeName(value))) return true;
  }
  return false;
}

/** Fields that hold a person's slug or display name in wiki-server rows. */
const NAME_KEYS = [
  "slug", "name", "title", "displayName",
  "personSlug", "personTitle", "personName", "personDisplayName",
  "candidateDisplayName", "recipientName", "holderName", "holderDisplayName",
];

/** Fields that hold a person's PG entity id in wiki-server rows. */
const ID_KEYS = [
  "id", "personId", "personEntityId", "entityId", "candidateEntityId",
  "recipientId", "recipientEntityId", "holderId", "holderEntityId",
];

function stripSid(id: string): string {
  return id.startsWith("sid_") ? id.slice(4) : id;
}

function identifiesHiddenPerson(obj: Record<string, unknown>): boolean {
  for (const key of NAME_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && isHiddenPerson(v)) return true;
  }
  for (const key of ID_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && HIDDEN_PERSON_IDS.has(stripSid(v))) return true;
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Remove every row that identifies a hidden person from a JSON value, at any
 * depth: array elements are filtered out and object-valued properties (e.g.
 * id -> entity lookup maps) are deleted. Returns null if the value itself is
 * a hidden person's record.
 */
export function scrubHiddenPeople<T>(value: T): T | null {
  if (Array.isArray(value)) {
    return value
      .filter((el) => !(isPlainObject(el) && identifiesHiddenPerson(el)))
      .map((el) => scrubHiddenPeople(el)) as T;
  }
  if (isPlainObject(value)) {
    if (identifiesHiddenPerson(value)) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (HIDDEN_PERSON_IDS.has(stripSid(k))) continue;
      if (isPlainObject(v) && identifiesHiddenPerson(v)) continue;
      out[k] = scrubHiddenPeople(v);
    }
    return out as T;
  }
  return value;
}
