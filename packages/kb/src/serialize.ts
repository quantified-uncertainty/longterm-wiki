/**
 * Serialization: Graph → JSON (for downstream consumers like build-data).
 */

import type { Graph } from "./graph.ts";

export interface SerializedKB {
  things: ReturnType<Graph["getAllThings"]>;
  facts: Record<string, ReturnType<Graph["getFacts"]>>;
  properties: ReturnType<Graph["getAllProperties"]>;
  schemas: ReturnType<Graph["getAllSchemas"]>;
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
  for (const thing of things) {
    const thingFacts = graph.getFacts(thing.id);
    if (thingFacts.length > 0) {
      facts[thing.id] = thingFacts;
    }
  }

  return { things, facts, properties, schemas };
}
