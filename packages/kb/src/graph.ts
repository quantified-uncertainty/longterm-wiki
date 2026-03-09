/**
 * In-memory knowledge base graph.
 * The main class users interact with after loading YAML via loadKB().
 */

import type {
  Entity,
  Fact,
  Property,
  TypeSchema,
  ItemCollection,
  ItemEntry,
  FactQuery,
  PropertyQuery,
} from "./types";

// ── KB type aliases ─────────────────────────────────────────────────────────
//
// Maps entity type names (from data/entities/) to KB schema type names
// (from packages/kb/data/schemas/). The canonical entity type system uses
// "model" but the KB schema is named "ai-model" to be more descriptive.
// This alias ensures model entities are validated against the ai-model schema.

export const KB_TYPE_ALIASES: Record<string, string> = {
  model: "ai-model",
};

/** Reverse map: schema type → entity type alias(es) that map to it. */
const KB_TYPE_REVERSE: Map<string, string[]> = new Map();
for (const [alias, canonical] of Object.entries(KB_TYPE_ALIASES)) {
  const existing = KB_TYPE_REVERSE.get(canonical) ?? [];
  existing.push(alias);
  KB_TYPE_REVERSE.set(canonical, existing);
}

/**
 * Resolves an entity type to its KB schema type.
 * If the type has an alias (e.g., "model" → "ai-model"), returns the alias target.
 * Otherwise returns the type unchanged.
 */
export function resolveKBType(type: string): string {
  return KB_TYPE_ALIASES[type] ?? type;
}

export class Graph {
  private entities: Map<string, Entity> = new Map();
  private facts: Map<string, Fact[]> = new Map(); // keyed by subjectId
  private factIds: Set<string> = new Set(); // dedup guard
  private properties: Map<string, Property> = new Map();
  private schemas: Map<string, TypeSchema> = new Map();
  // entityId → collectionName → collection
  private items: Map<string, Map<string, ItemCollection>> = new Map();
  // stableId → slug reverse index
  private stableIdIndex: Map<string, string> = new Map();

  // ── Mutation (used by loader and inverse computation) ──────────────

  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
    this.stableIdIndex.set(entity.stableId, entity.id);
  }

  /**
   * Adds a fact to the graph. Silently skips if a fact with the same ID
   * already exists (deduplication for inverse computation re-runs).
   */
  addFact(fact: Fact): void {
    if (this.factIds.has(fact.id)) return; // dedup
    this.factIds.add(fact.id);

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
    entityId: string,
    collectionName: string,
    collection: ItemCollection
  ): void {
    let entityCollections = this.items.get(entityId);
    if (!entityCollections) {
      entityCollections = new Map();
      this.items.set(entityId, entityCollections);
    }
    entityCollections.set(collectionName, collection);
  }

  // ── Entity queries ─────────────────────────────────────────────────

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  /** Resolve a stableId to its Entity. */
  getEntityByStableId(stableId: string): Entity | undefined {
    const slug = this.stableIdIndex.get(stableId);
    return slug ? this.entities.get(slug) : undefined;
  }

  /** Resolve a stableId to a slug. Returns undefined if not found. */
  resolveStableId(stableId: string): string | undefined {
    return this.stableIdIndex.get(stableId);
  }

  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  getByType(type: string): Entity[] {
    // Match entities whose type is either the given type or any alias that
    // maps to it (e.g., getByType("ai-model") also returns type:"model" entities).
    const aliases = KB_TYPE_REVERSE.get(type) ?? [];
    return Array.from(this.entities.values()).filter(
      (t) => t.type === type || aliases.includes(t.type)
    );
  }

  // ── Fact queries ───────────────────────────────────────────────────

  getFacts(entityId: string, query?: FactQuery): Fact[] {
    const all = this.facts.get(entityId) ?? [];
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
   * Returns the most recent fact for a given (entityId, propertyId) pair,
   * ordering by asOf descending. Facts without asOf come last.
   */
  getLatest(entityId: string, propertyId: string): Fact | undefined {
    const facts = this.getFacts(entityId, { property: propertyId });
    if (facts.length === 0) return undefined;

    return facts.slice().sort((a, b) => {
      if (a.asOf === undefined && b.asOf === undefined) return 0;
      if (a.asOf === undefined) return 1;
      if (b.asOf === undefined) return -1;
      return b.asOf.localeCompare(a.asOf);
    })[0];
  }

  /**
   * Returns the latest fact per entity for a given property.
   * Only entities that have at least one fact with this property are included.
   */
  getByProperty(
    propertyId: string,
    query?: PropertyQuery
  ): Map<string, Fact> {
    const result = new Map<string, Fact>();

    for (const entityId of this.entities.keys()) {
      const latest = this.getLatest(entityId, propertyId);
      if (latest !== undefined) {
        result.set(entityId, latest);
      }
    }

    return result;
  }

  /**
   * Returns all facts per entity for a given property (full history).
   * Unlike getByProperty(), this returns arrays of facts, not just the latest.
   */
  getAllByProperty(propertyId: string): Map<string, Fact[]> {
    const result = new Map<string, Fact[]>();

    for (const entityId of this.entities.keys()) {
      const facts = this.getFacts(entityId, { property: propertyId });
      if (facts.length > 0) {
        result.set(entityId, facts);
      }
    }

    return result;
  }

  /**
   * Returns the IDs of entities referenced by ref/refs facts on this entity.
   */
  getRelated(entityId: string, propertyId: string): string[] {
    const facts = this.getFacts(entityId, { property: propertyId });
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

  getItemCollectionNames(entityId: string): string[] {
    const entityCollections = this.items.get(entityId);
    if (!entityCollections) return [];
    return Array.from(entityCollections.keys());
  }

  getItems(entityId: string, collectionName: string): ItemEntry[] {
    const entityCollections = this.items.get(entityId);
    if (!entityCollections) return [];

    const collection = entityCollections.get(collectionName);
    if (!collection) return [];

    return Object.entries(collection.entries).map(([key, fields]) => ({
      key,
      fields,
    }));
  }

  /**
   * Scans all items across all entities for fields that reference the
   * given entityId. Returns matches with context about where they appear.
   *
   * Uses schema field definitions to identify `ref` type fields. Falls
   * back to string-matching if no schema is available.
   */
  getItemsMentioning(
    entityId: string
  ): Array<{
    ownerEntityId: string;
    collection: string;
    entry: ItemEntry;
    /** Which field(s) contain the reference */
    matchingFields: string[];
  }> {
    const results: Array<{
      ownerEntityId: string;
      collection: string;
      entry: ItemEntry;
      matchingFields: string[];
    }> = [];

    for (const [ownerEntityId, entityCollections] of this.items.entries()) {
      if (ownerEntityId === entityId) continue; // Skip self-references

      const ownerEntity = this.entities.get(ownerEntityId);
      const schema = ownerEntity
        ? this.getSchema(ownerEntity.type)
        : undefined;

      for (const [collectionName, collection] of entityCollections.entries()) {
        const collectionSchema = schema?.items?.[collectionName];
        const fieldDefs = collectionSchema?.fields;

        for (const [entryKey, fields] of Object.entries(collection.entries)) {
          const matchingFields: string[] = [];

          for (const [fieldName, fieldValue] of Object.entries(fields)) {
            const fieldDef = fieldDefs?.[fieldName];

            // Check ref fields explicitly
            if (fieldDef?.type === "ref" && fieldValue === entityId) {
              matchingFields.push(fieldName);
            }
            // Also check string values that match (covers untyped fields)
            else if (
              !fieldDef &&
              typeof fieldValue === "string" &&
              fieldValue === entityId
            ) {
              matchingFields.push(fieldName);
            }
          }

          if (matchingFields.length > 0) {
            results.push({
              ownerEntityId,
              collection: collectionName,
              entry: { key: entryKey, fields },
              matchingFields,
            });
          }
        }
      }
    }

    return results;
  }

  // ── Property & schema queries ──────────────────────────────────────

  getProperty(id: string): Property | undefined {
    return this.properties.get(id);
  }

  getAllProperties(): Property[] {
    return Array.from(this.properties.values());
  }

  getSchema(type: string): TypeSchema | undefined {
    return this.schemas.get(type) ?? this.schemas.get(resolveKBType(type));
  }

  getAllSchemas(): TypeSchema[] {
    return Array.from(this.schemas.values());
  }
}
