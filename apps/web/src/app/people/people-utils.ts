/**
 * Shared utilities for /people routes.
 */
import {
  getKBEntities,
  getKBEntity,
  getKBRecords,
  resolveKBSlug,
  getKBSlugMap,
  getKBEntitySlug,
} from "@/data/kb";
import type { Entity, RecordEntry } from "@longterm-wiki/kb";

/**
 * Resolve a URL slug (e.g., "dario-amodei") to a KB person entity.
 */
export function resolvePersonBySlug(slug: string): Entity | undefined {
  const entityId = resolveKBSlug(slug);
  if (!entityId) return undefined;
  const entity = getKBEntity(entityId);
  if (!entity || entity.type !== "person") return undefined;
  return entity;
}

/**
 * Get all person slugs for generateStaticParams.
 */
export function getPersonSlugs(): string[] {
  const slugMap = getKBSlugMap();
  const entities = getKBEntities();
  const personIds = new Set(
    entities.filter((e) => e.type === "person").map((e) => e.id),
  );

  return Object.entries(slugMap)
    .filter(([, id]) => personIds.has(id))
    .map(([slug]) => slug);
}

/**
 * Find all key-person records across all organizations that reference this person.
 * Returns records along with the owning organization entity.
 *
 * Record fields use slugs (e.g., "dario-amodei"), not entity IDs,
 * so we check against both.
 */
export function getOrgRolesForPerson(
  personEntityId: string,
): Array<{ org: Entity; record: RecordEntry }> {
  const personSlug = getKBEntitySlug(personEntityId);
  const entities = getKBEntities();
  const results: Array<{ org: Entity; record: RecordEntry }> = [];

  for (const entity of entities) {
    if (entity.type !== "organization") continue;
    const keyPersons = getKBRecords(entity.id, "key-persons");
    for (const record of keyPersons) {
      const personField = record.fields.person;
      if (personField === personEntityId || personField === personSlug) {
        results.push({ org: entity, record });
      }
    }
  }

  return results;
}
