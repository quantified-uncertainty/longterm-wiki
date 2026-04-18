/**
 * Shared resource ID resolution for endpoints that accept mixed-format input.
 *
 * After QUA-549 Phase B, every FK in resource-adjacent tables (proposed_claims,
 * resource_papers, resource_forum_posts, resource_policy_docs, resource_citations,
 * etc.) references `resources.stable_id` rather than the legacy hex16 `resources.id`.
 * Existing clients still send either form, so write paths must canonicalize to
 * stable_id before insert.
 *
 * `resolveResourceIds()` builds a translation map by looking up both columns in a
 * single query. Callers then pick strict mode (fail on `missing.length > 0`) or
 * lenient mode (let the FK reject truly invalid values at write time).
 *
 * Replaces two local copies of the same pattern in
 * `POST /resources/batch-details` (QUA-566 Phase B.3) and
 * `POST /claims/propose` (QUA-573 Phase B.1c). See QUA-601.
 */

type RawDb = ReturnType<typeof import("../../db.js").getDb>;

export interface ResolveResourceIdsResult {
  /** Bi-directional map: both hex16 and sid_ input forms → canonical stable_id. */
  map: Map<string, string>;
  /** Unique input IDs that matched no existing resource (either column). */
  missing: string[];
  /** Convenience lookup: canonical stable_id, or the input itself when unknown. */
  resolve: (input: string) => string;
}

/**
 * Resolve a batch of resource ID inputs to their canonical stable_id form.
 *
 * Accepts either `resources.id` (hex16) or `resources.stable_id` (sid_) and
 * returns a map that translates either form to the stable_id. Inputs that
 * match no row land in `missing` — the caller decides whether that's fatal.
 *
 * A resource is considered resolvable only when it has a non-null stable_id.
 * Legacy rows without a stable_id are treated as `missing` (there is no
 * canonical form to write).
 */
export async function resolveResourceIds(
  db: RawDb,
  inputIds: readonly string[],
): Promise<ResolveResourceIdsResult> {
  const unique = [...new Set(inputIds)];
  const map = new Map<string, string>();

  if (unique.length > 0) {
    const rows = await db<{ id: string; stable_id: string | null }[]>`
      SELECT id, stable_id FROM resources
      WHERE id = ANY(${unique}) OR stable_id = ANY(${unique})
    `;
    for (const r of rows) {
      if (r.stable_id) {
        map.set(r.id, r.stable_id);
        map.set(r.stable_id, r.stable_id);
      }
    }
  }

  const missing = unique.filter((id) => !map.has(id));
  return {
    map,
    missing,
    resolve: (input: string): string => map.get(input) ?? input,
  };
}
