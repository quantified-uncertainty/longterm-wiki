/**
 * Determines whether a column name represents an entity reference
 * that should be resolved to a display name.
 *
 * Column names come from the PG schema (snake_case) via buildSchemaForTable.
 *
 * IMPORTANT: endsWith("_entity_id") does NOT match bare "entity_id"
 * because "_entity_id" (10 chars) is longer than "entity_id" (9 chars).
 * We must match "entity_id" explicitly.
 */
export function isEntityRefColumn(columnName: string): boolean {
  return (
    columnName.endsWith("EntityId") ||
    columnName.endsWith("_entity_id") ||
    columnName === "entity_id" ||
    columnName === "stableId" ||
    columnName === "stable_id" ||
    columnName === "parentOrgId" ||
    columnName === "parent_org_id" ||
    columnName === "parent_thing_id" ||
    columnName === "org_id" ||
    columnName === "model_id" ||
    columnName === "subject"
  );
}

/**
 * Determines whether a row key (camelCase from Drizzle) represents
 * an entity reference whose stableId should be collected for batch resolution.
 *
 * Used on the server side (entity-profile.ts) to collect stableIds
 * for display name resolution.
 */
export function isEntityRefKey(key: string): boolean {
  return (
    key.endsWith("EntityId") ||
    key === "stableId" ||
    key === "personId" ||
    key === "parentOrgId" ||
    key === "orgId" ||
    key === "entityId" ||
    key === "parentThingId" ||
    key === "modelId" ||
    key === "subject"
  );
}
