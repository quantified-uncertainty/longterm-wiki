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
 * Compute candidate slugs for a record: the bare-name slug and the
 * owner-prefixed form. Caller picks which to assign based on collisions.
 *
 * If the bare-name slug already starts with (or equals) the owner slug —
 * e.g. name="Anthropic Series G" with ownerSlug="anthropic" — no double-
 * prefixing.
 *
 * @param {{key: string, ownerEntityId: string, fields: Record<string, unknown>}} record
 * @param {(stableId: string) => string | null} getOwnerSlug
 * @returns {{bare: string, withOwner: string}}
 */
export function candidateSlugs(record, getOwnerSlug) {
  const rawName = typeof record.fields.name === "string" ? record.fields.name : "";
  const baseSlug = slugify(rawName) || slugify(record.key);
  const ownerSlug = record.ownerEntityId ? getOwnerSlug(record.ownerEntityId) : null;

  let withOwner;
  if (!ownerSlug) {
    withOwner = baseSlug;
  } else if (baseSlug === ownerSlug || baseSlug.startsWith(`${ownerSlug}-`)) {
    withOwner = baseSlug;
  } else {
    withOwner = baseSlug ? `${ownerSlug}-${baseSlug}` : ownerSlug;
  }

  return { bare: baseSlug, withOwner };
}

/**
 * Assign a unique slug to every record in a collection. Mutates each record
 * to add a `slug` field. Two-pass: first try the preferred slug for the
 * collection; collisions cascade to owner-prefixed → 4-char key suffix.
 *
 * For `funding-rounds`, the preferred slug is owner-prefixed (round names
 * like "Series A" recur at every funder, so namespacing is the default).
 * For `funding-programs`, the preferred slug is the bare name (program
 * names like "Rise Global Talent Program" are usually distinctive); a
 * cross-funder collision falls back to the owner-prefixed form.
 *
 * Slugs are also guarded against shadowing other records' 10-char `key`
 * values: if a slugified name happens to equal another record's key, we
 * apply the suffix immediately so legacy `/funding-*\/<key>` URLs always
 * resolve to the right record. Without the guard, slug-first lookup in
 * `findProgramRecord` could return the wrong record.
 *
 * @param {Array<{key: string, ownerEntityId: string, fields: Record<string, unknown>, slug?: string}>} records
 * @param {string} collection
 * @param {(stableId: string) => string | null} getOwnerSlug
 * @returns {Map<string, string>} Map of record.key → assigned slug.
 */
export function assignSlugs(records, collection, getOwnerSlug) {
  const candidates = records.map((r) => ({
    record: r,
    ...candidateSlugs(r, getOwnerSlug),
  }));

  // For funding-rounds, the preferred slug is owner-prefixed — base names
  // ("Series A") recur at every company. For funding-programs the bare
  // form is preferred; only colliding ones need owner-prefixing.
  const preferOwner = collection === "funding-rounds";

  // Count first-choice slug occurrences so we know which need disambiguation.
  const firstChoiceCounts = new Map();
  for (const c of candidates) {
    const first = preferOwner ? c.withOwner : c.bare;
    firstChoiceCounts.set(first, (firstChoiceCounts.get(first) ?? 0) + 1);
  }

  // Slug-vs-key shadowing guard: collect every record key so we never assign
  // a slug that equals some other record's legacy URL identifier.
  const keys = new Set(records.map((r) => r.key));

  const taken = new Set();
  const assigned = new Map();

  // Sort by record key so collision suffixes are stable across builds.
  candidates.sort((a, b) => a.record.key.localeCompare(b.record.key));

  for (const c of candidates) {
    const first = preferOwner ? c.withOwner : c.bare;
    const second = preferOwner ? c.withOwner : c.withOwner;
    // For funding-rounds (preferOwner): second === first, so no second-choice
    // cascade — collisions go straight to the suffix path. Owner-prefixed
    // slug is the contract; we never strip back to a bare round name.
    // For funding-programs: second is withOwner (a real fallback before suffix).

    // Cascade: first-choice → second-choice (when distinct) → suffixed.
    let candidate;
    if (
      (firstChoiceCounts.get(first) ?? 0) === 1 &&
      !taken.has(first) &&
      !shadowsOtherKey(first, c.record.key, keys)
    ) {
      candidate = first;
    } else if (
      first !== second &&
      !taken.has(second) &&
      !shadowsOtherKey(second, c.record.key, keys)
    ) {
      candidate = second;
    } else {
      candidate = first;
    }

    if (!taken.has(candidate) && !shadowsOtherKey(candidate, c.record.key, keys)) {
      taken.add(candidate);
      assigned.set(c.record.key, candidate);
      c.record.slug = candidate;
      continue;
    }

    // Need a suffix to disambiguate. Use the canonical 4-char prefix of the
    // record's own key (lowercased, filtered) — deterministic across builds
    // and ties the suffix to the right record.
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

/**
 * True when `slug` equals an existing record's `key`, but not the owning
 * record's own key. Prevents `/funding-rounds/<slug>` from shadowing the
 * legacy `/funding-rounds/<key>` URL of a different record.
 */
function shadowsOtherKey(slug, ownKey, keys) {
  return slug !== ownKey && keys.has(slug);
}
