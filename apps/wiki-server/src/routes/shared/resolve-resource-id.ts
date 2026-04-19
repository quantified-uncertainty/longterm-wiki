/**
 * Resolve resource ID inputs that may be either `resources.id` (hex16) or
 * `resources.stable_id` (sid_) to the canonical stable_id form.
 *
 * All FKs in resource-adjacent tables (proposed_claims, resource_papers,
 * resource_forum_posts, resource_policy_docs, resource_citations, ...) point
 * at `resources.stable_id`, so write paths must canonicalize before insert.
 *
 * The caller picks strict (reject when `missing.length > 0`) or lenient
 * (pass through and let the FK reject at insert).
 */

type RawDb = ReturnType<typeof import("../../db.js").getDb>;

export interface ResolveResourceIdsResult {
  /** Unique input IDs that matched no existing resource (either column). */
  missing: string[];
  /** Canonical stable_id, or the input itself when unknown. */
  resolve: (input: string) => string;
}

/**
 * Only resources with a non-null stable_id are considered resolvable; legacy
 * rows without one land in `missing` (no canonical form to write).
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

  return {
    missing: unique.filter((id) => !map.has(id)),
    resolve: (input: string): string => map.get(input) ?? input,
  };
}
