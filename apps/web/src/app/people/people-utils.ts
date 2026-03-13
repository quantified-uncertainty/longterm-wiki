/**
 * Shared utilities for /people routes.
 *
 * Personnel data (key-persons, board-seats, career-history) is fetched
 * from PostgreSQL during build and merged into kb-data.json as KB records.
 *
 * Career data comes from the KB records layer (populated by build-data.mjs
 * from the wiki-server personnel table). Career-history records are keyed
 * by personId, with fields: organization, title, start, end, source, notes.
 */
import {
  getKBRecords,
  getKBEntitySlug,
  getAllKBRecords,
  getKBEntity,
  resolveKBSlug,
  type KBRecordEntry,
} from "@/data/kb";
import {
  resolveEntityBySlug,
  getEntitySlugs,
} from "@/lib/directory-utils";

/**
 * Check whether a record's person/member field matches a given entity ID.
 *
 * Records from PG store canonical entity IDs (10-char hashes) in their
 * endpoint fields, but records loaded from YAML store slugs (e.g.,
 * "dario-amodei"). This helper handles both formats so that lookups
 * work regardless of the data source.
 */
function matchesPersonField(
  fieldValue: unknown,
  personEntityId: string,
): boolean {
  if (typeof fieldValue !== "string") return false;
  // Direct entity-ID match (PG data)
  if (fieldValue === personEntityId) return true;
  // Slug match (YAML data): resolve the slug to an entity ID
  const resolvedId = resolveKBSlug(fieldValue);
  return resolvedId === personEntityId;
}

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
    if (!matchesPersonField(rec.fields.person, personEntityId)) continue;

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
    if (!matchesPersonField(rec.fields.member, personEntityId)) continue;

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

// -- Career history -------------------------------------------------------

export interface CareerHistoryEntry {
  key: string;
  organization: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  source: string | null;
  notes: string | null;
}

/**
 * Get career history entries for a person.
 * Reads from the KB records layer (career-history collection).
 * Returns entries sorted by start date (most recent first).
 */
export function getCareerHistory(personEntityId: string): CareerHistoryEntry[] {
  const records: KBRecordEntry[] = getKBRecords(
    personEntityId,
    "career-history",
  );

  const entries: CareerHistoryEntry[] = records.map((r) => ({
    key: r.key,
    organization: String(r.fields.organization ?? ""),
    title: String(r.fields.title ?? ""),
    startDate: r.fields.start ? String(r.fields.start) : null,
    endDate: r.fields.end ? String(r.fields.end) : null,
    source: r.fields.source ? String(r.fields.source) : null,
    notes: r.fields.notes ? String(r.fields.notes) : null,
  }));

  // Sort: current roles first, then by start date descending
  entries.sort((a, b) => {
    const endA = a.endDate ? 1 : 0;
    const endB = b.endDate ? 1 : 0;
    if (endA !== endB) return endA - endB;
    const sa = a.startDate ?? "";
    const sb = b.startDate ?? "";
    return sb.localeCompare(sa);
  });

  return entries;
}
