/**
 * In-memory knowledge base graph.
 * The main class users interact with after loading YAML via loadKB().
 */

import type {
  Entity,
  Fact,
  Property,
  TypeSchema,
  FactQuery,
  PropertyQuery,
} from "./types";

export class Graph {
  private entities: Map<string, Entity> = new Map(); // keyed by entity.id (stableId)
  /** Tracks duplicate entity IDs detected during loading */
  private _duplicateIds: Array<{ id: string; name: string; existingName: string }> = [];
  private facts: Map<string, Fact[]> = new Map(); // keyed by entity.id (subjectId)
  private factIds: Set<string> = new Set(); // dedup guard
  private properties: Map<string, Property> = new Map();
  private schemas: Map<string, TypeSchema> = new Map();

  // ── Mutation (used by loader and inverse computation) ──────────────

  addEntity(entity: Entity): void {
    const existing = this.entities.get(entity.id);
    if (existing && existing.name !== entity.name) {
      this._duplicateIds.push({
        id: entity.id,
        name: entity.name,
        existingName: existing.name,
      });
    }
    this.entities.set(entity.id, entity);
  }

  /** Returns duplicate entity IDs detected during loading. */
  getDuplicateIds(): Array<{ id: string; name: string; existingName: string }> {
    return this._duplicateIds;
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

  // ── Entity queries ─────────────────────────────────────────────────

  /**
   * Look up an entity by its ID (stable 10-char).
   */
  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  /**
   * @deprecated Use `getEntity()` instead.
   */
  getEntityByStableId(stableId: string): Entity | undefined {
    return this.getEntity(stableId);
  }

  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  getByType(type: string): Entity[] {
    return Array.from(this.entities.values()).filter((t) => t.type === type);
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
