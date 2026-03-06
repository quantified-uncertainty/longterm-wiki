/**
 * Serialization: Graph → JSON (for downstream consumers like build-data).
 */

import type { Graph } from "./graph";
import type { ItemEntry } from "./types";

export interface SerializedKB {
  things: ReturnType<Graph["getAllThings"]>;
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
  const things = graph.getAllThings();
  const properties = graph.getAllProperties();
  const schemas = graph.getAllSchemas();

  const facts: SerializedKB["facts"] = {};
  const items: SerializedKB["items"] = {};

  for (const thing of things) {
    const thingFacts = graph.getFacts(thing.id);
    if (thingFacts.length > 0) {
      facts[thing.id] = thingFacts;
    }

    // Serialize item collections for this thing
    const schema = graph.getSchema(thing.type);
    if (schema?.items) {
      const thingItems: Record<string, ItemEntry[]> = {};
      for (const collectionName of Object.keys(schema.items)) {
        const entries = graph.getItems(thing.id, collectionName);
        if (entries.length > 0) {
          thingItems[collectionName] = entries;
        }
      }
      if (Object.keys(thingItems).length > 0) {
        items[thing.id] = thingItems;
      }
    }
  }

  return { things, facts, properties, schemas, items };
}
