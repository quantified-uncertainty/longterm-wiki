/**
 * Serialization: Graph → JSON (for downstream consumers like build-data).
 */

import type { Graph } from "./graph";
import type { ItemEntry } from "./types";

export interface SerializedKB {
  entities: ReturnType<Graph["getAllEntities"]>;
  facts: Record<string, ReturnType<Graph["getFacts"]>>;
  properties: ReturnType<Graph["getAllProperties"]>;
  schemas: ReturnType<Graph["getAllSchemas"]>;
  items: Record<string, Record<string, ItemEntry[]>>;
}

/**
 * Serialize a Graph to a plain JSON-friendly object.
 * Useful for writing to database.json or sending over the wire.
 */
export function serialize(graph: Graph): SerializedKB {
  const entities = graph.getAllEntities();
  const properties = graph.getAllProperties();
  const schemas = graph.getAllSchemas();

  const facts: SerializedKB["facts"] = {};
  const items: SerializedKB["items"] = {};

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
  }

  return { entities, facts, properties, schemas, items };
}
