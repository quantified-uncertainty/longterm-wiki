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
  /** Records indexed by ownerEntityId → collectionName → entries */
  records: Record<string, Record<string, RecordEntry[]>>;
}

/**
 * Serialize a Graph to a plain JSON-friendly object.
 * Useful for writing to database.json or sending over the wire.
 */
export function serialize(graph: Graph): SerializedKB {
  const entities = graph.getAllEntities();
  const properties = graph.getAllProperties();
  const schemas = graph.getAllSchemas();
  const recordSchemas = graph.getAllRecordSchemas();

  const facts: SerializedKB["facts"] = {};
  const records: SerializedKB["records"] = {};

  for (const entity of entities) {
    const entityFacts = graph.getFacts(entity.id);
    // Key by slug for backward compat with frontend consumers (kb.ts uses slugs)
    if (entityFacts.length > 0) {
      facts[entity.slug] = entityFacts;
    }

    // Serialize record collections for this entity (keyed by slug)
    const recordCollections = graph.getAllRecordCollections(entity.id);
    if (recordCollections.size > 0) {
      const entityRecords: Record<string, RecordEntry[]> = {};
      for (const [collectionName, entries] of recordCollections) {
        if (entries.length > 0) {
          entityRecords[collectionName] = entries;
        }
      }
      if (Object.keys(entityRecords).length > 0) {
        records[entity.slug] = entityRecords;
      }
    }
  }

  return { entities, facts, properties, schemas, recordSchemas, records };
}
