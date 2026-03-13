/**
 * Serialization: Graph → JSON (for downstream consumers like build-data).
 */

import type { Graph } from "./graph";
import type { RecordEntry, RecordSchema } from "./types";

export interface SerializedKB {
  entities: ReturnType<Graph["getAllEntities"]>;
  facts: Record<string, ReturnType<Graph["getFacts"]>>;
  properties: ReturnType<Graph["getAllProperties"]>;
  schemas: ReturnType<Graph["getAllSchemas"]>;
  /** Record schemas (id → schema) */
  recordSchemas: RecordSchema[];
  /** Records indexed by entityId → collectionName → entries */
  records: Record<string, Record<string, RecordEntry[]>>;
  /** Maps YAML filename/slug → entity ID, for resolving slug-based lookups */
  slugToEntityId?: Record<string, string>;
  /** Maps previous slugs → current slug, for URL redirects when slugs change */
  previousSlugToCurrentSlug?: Record<string, string>;
}

/**
 * Serialize a Graph to a plain JSON-friendly object.
 * Useful for writing to database.json or sending over the wire.
 *
 * @param filenameMap Maps entity ID → YAML filename stem (e.g., "mK9pX3rQ7n" → "anthropic").
 *                    Used to key facts/records by filename for frontend backward compat.
 */
export function serialize(
  graph: Graph,
  filenameMap: Map<string, string>,
): SerializedKB {
  const entities = graph.getAllEntities();
  const properties = graph.getAllProperties();
  const schemas = graph.getAllSchemas();
  const recordSchemas = graph.getAllRecordSchemas();

  const facts: SerializedKB["facts"] = {};
  const records: SerializedKB["records"] = {};

  for (const entity of entities) {
    const entityFacts = graph.getFacts(entity.id);
    // Key by entity ID (the stable 10-char alphanumeric ID)
    if (entityFacts.length > 0) {
      facts[entity.id] = entityFacts;
    }

    // Serialize record collections for this entity
    const recordCollections = graph.getAllRecordCollections(entity.id);
    if (recordCollections.size > 0) {
      const entityRecords: Record<string, RecordEntry[]> = {};
      for (const [collectionName, entries] of recordCollections) {
        if (entries.length > 0) {
          entityRecords[collectionName] = entries;
        }
      }
      if (Object.keys(entityRecords).length > 0) {
        records[entity.id] = entityRecords;
      }
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
          if (previousSlugToCurrentSlug[prevSlug] && previousSlugToCurrentSlug[prevSlug] !== currentSlug) {
            console.warn(`[kb] duplicate previousSlug "${prevSlug}": claimed by both "${previousSlugToCurrentSlug[prevSlug]}" and "${currentSlug}"`);
          }
          previousSlugToCurrentSlug[prevSlug] = currentSlug;
        }
      }
    }
  }

  return {
    entities, facts, properties, schemas, recordSchemas, records,
    slugToEntityId,
    ...(Object.keys(previousSlugToCurrentSlug).length > 0 && { previousSlugToCurrentSlug }),
  };
}
