/**
 * Shared utilities for /people routes.
 */
import {
  getKBEntities,
  getKBRecords,
  getKBEntitySlug,
} from "@/data/kb";
import {
  resolveEntityBySlug,
  getEntitySlugs,
} from "@/lib/directory-utils";
import type { Entity, RecordEntry } from "@longterm-wiki/kb";

// Re-export generic utilities with people-specific signatures
export const resolvePersonBySlug = (slug: string) =>
  resolveEntityBySlug(slug, "person");

export const getPersonSlugs = () => getEntitySlugs("person");

/** Lazy-built index: personRef → Array<{ org, record }> across all organizations. */
let orgRolesIndex: Map<string, Array<{ org: Entity; record: RecordEntry }>> | undefined;

function buildOrgRolesIndex(): Map<string, Array<{ org: Entity; record: RecordEntry }>> {
  const index = new Map<string, Array<{ org: Entity; record: RecordEntry }>>();
  const entities = getKBEntities();

  for (const entity of entities) {
    if (entity.type !== "organization") continue;
    const keyPersons = getKBRecords(entity.id, "key-persons");
    for (const record of keyPersons) {
      const personField = record.fields.person;
      if (typeof personField !== "string") continue;
      const existing = index.get(personField) ?? [];
      existing.push({ org: entity, record });
      index.set(personField, existing);
    }
  }

  return index;
}

/**
 * Find all key-person records across all organizations that reference this person.
 * Uses a lazy-built index for O(1) lookups after initial build.
 */
export function getOrgRolesForPerson(
  personEntityId: string,
): Array<{ org: Entity; record: RecordEntry }> {
  if (!orgRolesIndex) {
    orgRolesIndex = buildOrgRolesIndex();
  }

  const personSlug = getKBEntitySlug(personEntityId);
  const byId = orgRolesIndex.get(personEntityId) ?? [];
  const bySlug = personSlug ? (orgRolesIndex.get(personSlug) ?? []) : [];

  // Deduplicate in case both match the same record
  const seen = new Set<string>();
  const results: Array<{ org: Entity; record: RecordEntry }> = [];
  for (const entry of [...byId, ...bySlug]) {
    const key = `${entry.org.id}-${entry.record.key}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(entry);
    }
  }
  return results;
}
