/**
 * Shared utilities for /people routes.
 *
 * Personnel data (key-persons, board-seats, career-history) is fetched
 * from PostgreSQL during build and merged into kb-data.json as KB records.
 */
import {
  getKBRecords,
  getKBEntitySlug,
  getAllKBRecords,
  getKBEntity,
  type KBRecordEntry,
} from "@/data/kb";
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
 * Uses getAllKBRecords to scan all orgs' key-persons collections,
 * filtering by fields.person === personEntityId.
 */
export function getOrgRolesForPerson(
  personEntityId: string,
): Array<{
  org: { id: string; name: string; type: string };
  record: { key: string; fields: Record<string, unknown> };
}> {
  const allKeyPersons = getAllKBRecords("key-persons");
  const results: Array<{
    org: { id: string; name: string; type: string };
    record: { key: string; fields: Record<string, unknown> };
  }> = [];

  for (const rec of allKeyPersons) {
    if (rec.fields.person !== personEntityId) continue;

    const orgEntity = getKBEntity(rec.ownerEntityId);
    if (!orgEntity) continue;

    results.push({
      org: {
        id: orgEntity.id,
        name: orgEntity.name,
        type: orgEntity.type ?? "organization",
      },
      record: {
        key: rec.key,
        fields: rec.fields,
      },
    });
  }

  return results;
}

/**
 * Find all board-seat records across all organizations that reference this person.
 * Uses getAllKBRecords to scan all orgs' board-seats collections,
 * filtering by fields.member === personEntityId.
 */
export function getBoardSeatsForPerson(
  personEntityId: string,
): Array<{
  org: { id: string; name: string; type: string };
  record: { key: string; fields: Record<string, unknown> };
}> {
  const allBoardSeats = getAllKBRecords("board-seats");
  const results: Array<{
    org: { id: string; name: string; type: string };
    record: { key: string; fields: Record<string, unknown> };
  }> = [];

  for (const rec of allBoardSeats) {
    if (rec.fields.member !== personEntityId) continue;

    const orgEntity = getKBEntity(rec.ownerEntityId);
    if (!orgEntity) continue;

    results.push({
      org: {
        id: orgEntity.id,
        name: orgEntity.name,
        type: orgEntity.type ?? "organization",
      },
      record: {
        key: rec.key,
        fields: rec.fields,
      },
    });
  }

  return results;
}

/**
 * Get career history records for a person.
 * Career records have ownerEntityId === personEntityId, so we can look up directly.
 */
export function getCareerHistoryForPerson(
  personEntityId: string,
): KBRecordEntry[] {
  return getKBRecords(personEntityId, "career-history");
}

/**
 * Resolve an organization entity ID to a display-friendly object.
 */
export function resolveOrgForCareer(
  orgId: string,
): { id: string; name: string; slug: string | undefined } | null {
  const orgEntity = getKBEntity(orgId);
  if (!orgEntity) return null;
  return {
    id: orgEntity.id,
    name: orgEntity.name,
    slug: getKBEntitySlug(orgEntity.id),
  };
}
