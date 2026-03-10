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
  /** Records indexed by filename → collectionName → entries */
  records: Record<string, Record<string, RecordEntry[]>>;
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
    // Key by filename for backward compat with frontend consumers (kb.ts uses slug/filename keys)
    const key = filenameMap.get(entity.id) ?? entity.id;
    if (entityFacts.length > 0) {
      facts[key] = entityFacts;
    }

    // Serialize record collections for this entity (keyed by filename)
    const recordCollections = graph.getAllRecordCollections(entity.id);
    if (recordCollections.size > 0) {
      const entityRecords: Record<string, RecordEntry[]> = {};
      for (const [collectionName, entries] of recordCollections) {
        if (entries.length > 0) {
          entityRecords[collectionName] = entries;
        }
      }
      if (Object.keys(entityRecords).length > 0) {
        records[key] = entityRecords;
      }
    }
  }

  return { entities, facts, properties, schemas, recordSchemas, records };
}
