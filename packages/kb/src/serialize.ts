/**
 * Serialization: Graph → JSON (for downstream consumers like build-data).
 */

import type { Graph } from "./graph";
import type { ItemEntry, RecordEntry, RecordSchema } from "./types";

export interface SerializedKB {
  entities: ReturnType<Graph["getAllEntities"]>;
  facts: Record<string, ReturnType<Graph["getFacts"]>>;
  properties: ReturnType<Graph["getAllProperties"]>;
  schemas: ReturnType<Graph["getAllSchemas"]>;
  items: Record<string, Record<string, ItemEntry[]>>;
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
  const items: SerializedKB["items"] = {};
  const records: SerializedKB["records"] = {};

  for (const entity of entities) {
    const entityFacts = graph.getFacts(entity.id);
    if (entityFacts.length > 0) {
      facts[entity.id] = entityFacts;
    }

    // Serialize item collections for this entity
    const schema = graph.getSchema(entity.type);
    if (schema?.items) {
      const entityItems: Record<string, ItemEntry[]> = {};
      for (const collectionName of Object.keys(schema.items)) {
        const entries = graph.getItems(entity.id, collectionName);
        if (entries.length > 0) {
          entityItems[collectionName] = entries;
        }
      }
      if (Object.keys(entityItems).length > 0) {
        items[entity.id] = entityItems;
      }
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

  return { entities, facts, properties, schemas, items, recordSchemas, records };
}
