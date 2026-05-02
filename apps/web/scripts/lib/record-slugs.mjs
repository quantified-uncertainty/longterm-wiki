/**
 * URL-slug generation for FactBase records served from PG (funding-programs
 * and funding-rounds). Slugs are derived from the record's display name at
 * build-time. The 10-char `key` is preserved for verdict lookups and
 * legacy-URL redirects.
 *
 * Stability contract: same (name, ownerEntity, key) → same slug across
 * builds. Collisions are resolved deterministically (sorted by key), never
 * by build order.
 */

export function slugify(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/**
 * Compute candidate slugs for a record. `assignSlugs` picks `bare` or
 * `withOwner` based on the collection's policy and collision state.
 *
 * Skips double-prefixing when the bare slug already starts with the owner
 * slug (e.g. name "Anthropic Series G" + owner "anthropic").
 *
 * @param {{key: string, ownerEntityId: string, fields: Record<string, unknown>}} record
 * @param {(stableId: string) => string | null} getOwnerSlug
 * @returns {{bare: string, withOwner: string}}
 */
export function candidateSlugs(record, getOwnerSlug) {
  const rawName = typeof record.fields.name === "string" ? record.fields.name : "";
  const bare = slugify(rawName) || slugify(record.key);
  const ownerSlug = record.ownerEntityId ? getOwnerSlug(record.ownerEntityId) : null;

  let withOwner;
  if (!ownerSlug || bare === ownerSlug || bare.startsWith(`${ownerSlug}-`)) {
    withOwner = bare;
  } else {
    withOwner = bare ? `${ownerSlug}-${bare}` : ownerSlug;
  }

  return { bare, withOwner };
}

/**
 * Assign a unique URL slug to every record in a collection. Mutates each
 * record to add a `slug` field.
 *
 * Cascade per record: first-choice → fallback → 4-char key-prefix suffix.
 * For `funding-rounds`, first-choice is the owner-prefixed slug (round
 * names like "Series A" recur at every funder, so namespacing is the
 * contract — no fallback to bare). For `funding-programs`, first-choice
 * is the bare name; cross-funder collisions fall back to owner-prefixed.
 *
 * Slugs are guarded against equalling another record's 10-char `key` so
 * legacy `/funding-*\/<key>` URLs always resolve to the right record (the
 * detail-page lookup prefers slug; without the guard a slugified name
 * matching a sibling's key could shadow the legacy URL).
 *
 * @param {Array<{key: string, ownerEntityId: string, fields: Record<string, unknown>, slug?: string}>} records
 * @param {string} collection
 * @param {(stableId: string) => string | null} getOwnerSlug
 * @returns {Map<string, string>} Map of record.key → assigned slug.
 */
export function assignSlugs(records, collection, getOwnerSlug) {
  const preferOwner = collection === "funding-rounds";
  const candidates = records.map((r) => ({
    record: r,
    ...candidateSlugs(r, getOwnerSlug),
  }));

  const firstChoiceCounts = new Map();
  for (const c of candidates) {
    const first = preferOwner ? c.withOwner : c.bare;
    firstChoiceCounts.set(first, (firstChoiceCounts.get(first) ?? 0) + 1);
  }

  const keys = new Set(records.map((r) => r.key));
  const taken = new Set();
  const assigned = new Map();

  candidates.sort((a, b) => a.record.key.localeCompare(b.record.key));

  for (const c of candidates) {
    const first = preferOwner ? c.withOwner : c.bare;
    const fallback = c.withOwner; // collapses to `first` for funding-rounds

    let candidate;
    if (
      (firstChoiceCounts.get(first) ?? 0) === 1 &&
      !taken.has(first) &&
      !shadowsOtherKey(first, c.record.key, keys)
    ) {
      candidate = first;
    } else if (
      first !== fallback &&
      !taken.has(fallback) &&
      !shadowsOtherKey(fallback, c.record.key, keys)
    ) {
      candidate = fallback;
    } else {
      candidate = first;
    }

    if (!taken.has(candidate) && !shadowsOtherKey(candidate, c.record.key, keys)) {
      taken.add(candidate);
      assigned.set(c.record.key, candidate);
      c.record.slug = candidate;
      continue;
    }

    // Suffix from the record's own key — deterministic and ties uniqueness
    // back to the canonical id. The "|| 'x'" only fires for keys that are
    // entirely non-alphanumeric, which 10-char base62 keys never are.
    const suffix = c.record.key.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4) || "x";
    let final = `${candidate}-${suffix}`;
    let n = 1;
    while (taken.has(final) || shadowsOtherKey(final, c.record.key, keys)) {
      final = `${candidate}-${suffix}-${n++}`;
    }
    taken.add(final);
    assigned.set(c.record.key, final);
    c.record.slug = final;
  }

  return assigned;
}

function shadowsOtherKey(slug, ownKey, keys) {
  return slug !== ownKey && keys.has(slug);
}
