/**
 * Record slug generation for FactBase records served from PG.
 *
 * QUA-908: `/funding-programs/<10-char-id>` and `/funding-rounds/<10-char-id>`
 * exposed raw stableIds in the URL. This module generates human-readable URL
 * slugs from the record's display name (and owner-entity slug for namespacing
 * generic round names like "Series A").
 *
 * Slugs are assigned at build-time and stored on FactBaseRecordEntry.slug.
 * The 10-char `key` is preserved for verdict lookups, React keys, and
 * legacy-URL redirects in [id]/page.tsx.
 *
 * Stability contract: same (name, ownerEntity, key) → same slug across
 * builds. Collisions are resolved deterministically by appending a 4-char
 * suffix derived from the record's key, never by build order.
 */

/**
 * Slugify a string: lowercase, replace non-alphanumerics with hyphens,
 * collapse runs, and trim to a reasonable URL length.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  if (!text) return "";
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // strip combining marks (diacritics)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/**
 * Compute a candidate slug for a single record.
 *
 * For funding-rounds, generic round names ("Series A", "Seed") are namespaced
 * by the owning company's slug. For funding-programs, names are usually
 * distinctive (e.g. "Rise Global Talent Program"), so we only namespace when
 * the base slug would collide.
 *
 * @param {{key: string, ownerEntityId: string, fields: Record<string, unknown>}} record
 * @param {string} collection - "funding-programs" or "funding-rounds"
 * @param {(stableId: string) => string | null} getOwnerSlug
 * @returns {{base: string, withOwner: string}}
 */
export function candidateSlugs(record, collection, getOwnerSlug) {
  const name =
    typeof record.fields.name === "string" && record.fields.name.length > 0
      ? record.fields.name
      : record.key;
  const baseSlug = slugify(name);
  const ownerSlug = record.ownerEntityId
    ? getOwnerSlug(record.ownerEntityId)
    : null;

  // Compose the owner-prefixed candidate. If the base slug already starts
  // with the owner slug (name has the company/org name baked in), don't
  // double-prefix.
  let withOwner;
  if (!ownerSlug) {
    withOwner = baseSlug;
  } else if (baseSlug.startsWith(`${ownerSlug}-`) || baseSlug === ownerSlug) {
    withOwner = baseSlug;
  } else {
    withOwner = baseSlug ? `${ownerSlug}-${baseSlug}` : ownerSlug;
  }

  // For funding-rounds, prefer the owner-prefixed form because round names
  // are generic ("Series A" recurs at every funder). For funding-programs,
  // the base form is fine until a collision forces us to disambiguate.
  if (collection === "funding-rounds") {
    return { base: withOwner, withOwner };
  }
  return { base: baseSlug || withOwner, withOwner };
}

/**
 * Assign a unique slug to every record in a collection. Mutates each record
 * to add a `slug` field. Two-pass: first try the base slug; collisions get
 * the owner-prefixed slug; remaining collisions get a 4-char suffix from
 * the record key.
 *
 * @param {Array<{key: string, ownerEntityId: string, fields: Record<string, unknown>, slug?: string}>} records
 * @param {string} collection
 * @param {(stableId: string) => string | null} getOwnerSlug
 * @returns {Map<string, string>} Map of record.key → assigned slug.
 */
export function assignSlugs(records, collection, getOwnerSlug) {
  // Pre-compute candidates so we can detect collisions before assignment.
  const candidates = records.map((r) => ({
    record: r,
    ...candidateSlugs(r, collection, getOwnerSlug),
  }));

  // Count base-slug occurrences to decide which records need owner prefixing.
  const baseCounts = new Map();
  for (const c of candidates) {
    baseCounts.set(c.base, (baseCounts.get(c.base) ?? 0) + 1);
  }

  const taken = new Set();
  const assigned = new Map();

  // Sort deterministically by record key so collision suffixes are stable
  // across builds regardless of input order. Records are walked in this
  // order; the first sees the un-suffixed slug, later collisions get the
  // 4-char hash suffix.
  candidates.sort((a, b) => a.record.key.localeCompare(b.record.key));

  for (const c of candidates) {
    let candidate;
    if ((baseCounts.get(c.base) ?? 0) > 1 && c.withOwner !== c.base) {
      // Base slug is shared across multiple records — disambiguate by owner.
      candidate = c.withOwner;
    } else {
      candidate = c.base;
    }

    if (!taken.has(candidate)) {
      taken.add(candidate);
      assigned.set(c.record.key, candidate);
      c.record.slug = candidate;
      continue;
    }

    // Owner-prefix didn't disambiguate (e.g. two rounds at the same
    // company with the same name, or two records with no owner slug).
    // Fall back to a 4-char suffix from the record key.
    const suffix = c.record.key.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4) || "x";
    let final = `${candidate}-${suffix}`;
    let n = 1;
    while (taken.has(final)) {
      final = `${candidate}-${suffix}-${n++}`;
    }
    taken.add(final);
    assigned.set(c.record.key, final);
    c.record.slug = final;
  }

  return assigned;
}
