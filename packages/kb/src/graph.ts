/**
 * In-memory knowledge base graph.
 * The main class users interact with after loading YAML via loadKB().
 */

import type {
  Thing,
  Fact,
  Property,
  TypeSchema,
  ItemCollection,
  ItemEntry,
  FactQuery,
  PropertyQuery,
} from "./types";

export class Graph {
  private things: Map<string, Thing> = new Map();
  private facts: Map<string, Fact[]> = new Map(); // keyed by subjectId
  private properties: Map<string, Property> = new Map();
  private schemas: Map<string, TypeSchema> = new Map();
  // thingId → collectionName → collection
  private items: Map<string, Map<string, ItemCollection>> = new Map();

  // ── Mutation (used by loader and inverse computation) ──────────────

  addThing(thing: Thing): void {
    this.things.set(thing.id, thing);
  }

  addFact(fact: Fact): void {
    const existing = this.facts.get(fact.subjectId);
    if (existing) {
      existing.push(fact);
    } else {
      this.facts.set(fact.subjectId, [fact]);
    }
  }

  addProperty(property: Property): void {
    this.properties.set(property.id, property);
  }

  addSchema(schema: TypeSchema): void {
    this.schemas.set(schema.type, schema);
  }

  addItemCollection(
    thingId: string,
    collectionName: string,
    collection: ItemCollection
  ): void {
    let thingCollections = this.items.get(thingId);
    if (!thingCollections) {
      thingCollections = new Map();
      this.items.set(thingId, thingCollections);
    }
    thingCollections.set(collectionName, collection);
  }

  // ── Thing queries ──────────────────────────────────────────────────

  getThing(id: string): Thing | undefined {
    return this.things.get(id);
  }

  getAllThings(): Thing[] {
    return Array.from(this.things.values());
  }

  getByType(type: string): Thing[] {
    return Array.from(this.things.values()).filter((t) => t.type === type);
  }

  // ── Fact queries ───────────────────────────────────────────────────

  getFacts(thingId: string, query?: FactQuery): Fact[] {
    const all = this.facts.get(thingId) ?? [];
    let result = all;

    if (query?.property !== undefined) {
      result = result.filter((f) => f.propertyId === query.property);
    }

    if (query?.current) {
      result = result.filter((f) => f.validEnd === undefined);
    }

    return result;
  }

  /**
   * Returns the most recent fact for a given (thingId, propertyId) pair,
   * ordering by asOf descending. Facts without asOf come last.
   */
  getLatest(thingId: string, propertyId: string): Fact | undefined {
    const facts = this.getFacts(thingId, { property: propertyId });
    if (facts.length === 0) return undefined;

    return facts.slice().sort((a, b) => {
      if (a.asOf === undefined && b.asOf === undefined) return 0;
      if (a.asOf === undefined) return 1;
      if (b.asOf === undefined) return -1;
      return b.asOf.localeCompare(a.asOf);
    })[0];
  }

  /**
   * Returns a map of thingId → Fact for all things that have a fact with
   * the given propertyId. When `latest: true` is passed, only the most
   * recent fact per thing is returned.
   */
  getByProperty(
    propertyId: string,
    query?: PropertyQuery
  ): Map<string, Fact> {
    const result = new Map<string, Fact>();

    for (const thingId of this.things.keys()) {
      if (query?.latest) {
        const latest = this.getLatest(thingId, propertyId);
        if (latest !== undefined) {
          result.set(thingId, latest);
        }
      } else {
        // Without latest, return the most recent fact if multiple exist,
        // to keep the return type consistent (Map<string, Fact>).
        const latest = this.getLatest(thingId, propertyId);
        if (latest !== undefined) {
          result.set(thingId, latest);
        }
      }
    }

    return result;
  }

  /**
   * Returns the IDs of things referenced by ref/refs facts on this thing.
   */
  getRelated(thingId: string, propertyId: string): string[] {
    const facts = this.getFacts(thingId, { property: propertyId });
    const ids: string[] = [];

    for (const fact of facts) {
      if (fact.value.type === "ref") {
        ids.push(fact.value.value);
      } else if (fact.value.type === "refs") {
        ids.push(...fact.value.value);
      }
    }

    return ids;
  }

  // ── Item queries ───────────────────────────────────────────────────

  getItems(thingId: string, collectionName: string): ItemEntry[] {
    const thingCollections = this.items.get(thingId);
    if (!thingCollections) return [];

    const collection = thingCollections.get(collectionName);
    if (!collection) return [];

    return Object.entries(collection.entries).map(([key, fields]) => ({
      key,
      fields,
    }));
  }

  // ── Property & schema queries ──────────────────────────────────────

  getProperty(id: string): Property | undefined {
    return this.properties.get(id);
  }

  getAllProperties(): Property[] {
    return Array.from(this.properties.values());
  }

  getSchema(type: string): TypeSchema | undefined {
    return this.schemas.get(type);
  }

  getAllSchemas(): TypeSchema[] {
    return Array.from(this.schemas.values());
  }
}
