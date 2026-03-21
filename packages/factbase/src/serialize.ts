/**
 * Serialization: Graph → JSON (for downstream consumers like build-data).
 */

import type { Graph } from "./graph";

export interface SerializedKB {
  /**
   * @deprecated Entities are now owned by TableBase. This field is no longer
   * emitted by serialize() and will be removed in a future version.
   * Use getTypedEntities() / getTypedEntityByStableId() from tablebase.ts instead.
   */
  entities?: ReturnType<Graph["getAllEntities"]>;
  facts: Record<string, ReturnType<Graph["getFacts"]>>;
  properties: ReturnType<Graph["getAllProperties"]>;
  schemas: ReturnType<Graph["getAllSchemas"]>;
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
    // Key by entity ID (the stable 10-char alphawiki ID)
    if (entityFacts.length > 0) {
      facts[entity.id] = entityFacts;
    }
  }

  // Build previousSlug → currentSlug map for URL redirects
  // (entities are still in the graph for fact iteration; we just don't emit them)
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

  // Note: entities array and slugToEntityId are no longer emitted.
  // Entities are owned by TableBase (database.json typedEntities).
  // Slug→entityId resolution uses idRegistry.stableIdBySlug from database.json.
  return {
    facts, properties, schemas,
    ...(Object.keys(previousSlugToCurrentSlug).length > 0 && { previousSlugToCurrentSlug }),
  };
}
