/**
 * Shared utilities for /people routes.
 *
 * Note: Record-based org role lookups (key-persons) have been removed.
 * The getOrgRolesForPerson function now returns an empty array.
 */
import {
  resolveEntityBySlug,
  getEntitySlugs,
} from "@/lib/directory-utils";

// Re-export generic utilities with people-specific signatures
export const resolvePersonBySlug = (slug: string) =>
  resolveEntityBySlug(slug, "person");

export const getPersonSlugs = () => getEntitySlugs("person");

/**
 * Find all key-person records across all organizations that reference this person.
 * STUB: Records infrastructure has been removed. Returns empty array.
 */
export function getOrgRolesForPerson(
  _personEntityId: string,
): Array<{ org: { id: string; name: string; type: string }; record: { key: string; fields: Record<string, unknown> } }> {
  return [];
}
