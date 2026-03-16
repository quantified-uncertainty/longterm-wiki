/**
 * Serialization: Graph → JSON (for downstream consumers like build-data).
 */

import type { Graph } from "./graph";

export interface SerializedKB {
  entities: ReturnType<Graph["getAllEntities"]>;
  facts: Record<string, ReturnType<Graph["getFacts"]>>;
  properties: ReturnType<Graph["getAllProperties"]>;
  schemas: ReturnType<Graph["getAllSchemas"]>;
  /** Maps YAML filename/slug → entity ID, for resolving slug-based lookups */
  slugToEntityId?: Record<string, string>;
  /** Maps previous slugs → current slug, for URL redirects when slugs change */
  previousSlugToCurrentSlug?: Record<string, string>;
}

/**
 * Serialize a Graph to a plain JSON-friendly object.
 * Useful for writing to database.json or sending over the wire.
 *
 * Note: Records (grants, funding rounds, investments, etc.) are now served
 * exclusively from PostgreSQL and merged into factbase-data.json by
 * build-data.mjs. They are not part of the KB serialization.
 *
 * @param filenameMap Maps entity ID → YAML filename stem (e.g., "mK9pX3rQ7n" → "anthropic").
 *                    Used to key facts by filename for frontend backward compat.
 */
export function serialize(
  graph: Graph,
  filenameMap: Map<string, string>,
): SerializedKB {
  const entities = graph.getAllEntities();
  const properties = graph.getAllProperties();
  const schemas = graph.getAllSchemas();

  const facts: SerializedKB["facts"] = {};

  for (const entity of entities) {
    const entityFacts = graph.getFacts(entity.id);
    // Key by entity ID (the stable 10-char alphanumeric ID)
    if (entityFacts.length > 0) {
      facts[entity.id] = entityFacts;
    }
  }

  // Build slug → entity ID map for resolving slug-based lookups from MDX components
  const slugToEntityId: Record<string, string> = {};
  for (const [entityId, filename] of filenameMap) {
    slugToEntityId[filename] = entityId;
  }

  // Build previousSlug → currentSlug map for URL redirects
  const previousSlugToCurrentSlug: Record<string, string> = {};
  for (const entity of entities) {
    if (entity.previousSlugs) {
      const currentSlug = filenameMap.get(entity.id);
      if (currentSlug) {
        for (const prevSlug of entity.previousSlugs) {
          previousSlugToCurrentSlug[prevSlug] = currentSlug;
        }
      }
    }
  }

  return {
    entities, facts, properties, schemas,
    slugToEntityId,
    ...(Object.keys(previousSlugToCurrentSlug).length > 0 && { previousSlugToCurrentSlug }),
  };
}
