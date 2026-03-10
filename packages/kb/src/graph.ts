/**
 * In-memory knowledge base graph.
 * The main class users interact with after loading YAML via loadKB().
 */

import type {
  Entity,
  Fact,
  Property,
  TypeSchema,
  RecordSchema,
  RecordEntry,
  FactQuery,
  PropertyQuery,
} from "./types";

export class Graph {
  private entities: Map<string, Entity> = new Map(); // keyed by entity.id (stableId)
  private slugIndex: Map<string, string> = new Map(); // slug → entity.id
  /** Tracks duplicate entity IDs detected during loading */
  private _duplicateIds: Array<{ id: string; slug: string; existingSlug: string }> = [];
  private facts: Map<string, Fact[]> = new Map(); // keyed by entity.id (subjectId)
  private factIds: Set<string> = new Set(); // dedup guard
  private properties: Map<string, Property> = new Map();
  private schemas: Map<string, TypeSchema> = new Map();
  // Record schemas (id → schema)
  private recordSchemas: Map<string, RecordSchema> = new Map();
  // Primary index: ownerEntityId → collectionName → RecordEntry[]
  private records: Map<string, Map<string, RecordEntry[]>> = new Map();
  // Endpoint index: referencedEntityId → collectionName → RecordEntry[]
  private endpointIndex: Map<string, Map<string, RecordEntry[]>> = new Map();

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Resolves an entity ID or slug to the canonical entity ID.
   * Tries direct ID lookup first, then slug lookup.
   */
  private resolveToId(idOrSlug: string): string {
    if (this.entities.has(idOrSlug)) return idOrSlug;
    return this.slugIndex.get(idOrSlug) ?? idOrSlug;
  }

  // ── Mutation (used by loader and inverse computation) ──────────────

  addEntity(entity: Entity): void {
    const existing = this.entities.get(entity.id);
    if (existing && existing.slug !== entity.slug) {
      this._duplicateIds.push({
        id: entity.id,
        slug: entity.slug,
        existingSlug: existing.slug,
      });
    }
    this.entities.set(entity.id, entity);
    this.slugIndex.set(entity.slug, entity.id);
  }

  /** Returns duplicate entity IDs detected during loading. */
  getDuplicateIds(): Array<{ id: string; slug: string; existingSlug: string }> {
    return this._duplicateIds;
  }

  /**
   * Adds a fact to the graph. Silently skips if a fact with the same ID
   * already exists (deduplication for inverse computation re-runs).
   * The subjectId is resolved to the canonical entity ID if needed.
   */
  addFact(fact: Fact): void {
    if (this.factIds.has(fact.id)) return; // dedup
    this.factIds.add(fact.id);

    const subjectId = this.resolveToId(fact.subjectId);
    const existing = this.facts.get(subjectId);
    if (existing) {
      existing.push(fact);
    } else {
      this.facts.set(subjectId, [fact]);
    }
  }

  addProperty(property: Property): void {
    this.properties.set(property.id, property);
  }

  addSchema(schema: TypeSchema): void {
    this.schemas.set(schema.type, schema);
  }

  addRecordSchema(schema: RecordSchema): void {
    this.recordSchemas.set(schema.id, schema);
  }

  /**
   * Adds a record entry, indexing it in both the primary index (by owner)
   * and the endpoint index (by each explicit endpoint's entity ref).
   * The ownerEntityId and endpoint refs are resolved to canonical entity IDs.
   */
  addRecord(
    collectionName: string,
    entry: RecordEntry,
  ): void {
    const ownerId = this.resolveToId(entry.ownerEntityId);

    // Primary index: ownerEntityId → collectionName → entries
    let ownerCollections = this.records.get(ownerId);
    if (!ownerCollections) {
      ownerCollections = new Map();
      this.records.set(ownerId, ownerCollections);
    }
    let entries = ownerCollections.get(collectionName);
    if (!entries) {
      entries = [];
      ownerCollections.set(collectionName, entries);
    }
    entries.push(entry);

    // Endpoint index: scan explicit endpoint fields
    const schema = this.recordSchemas.get(entry.schema);
    if (schema) {
      for (const [endpointName, endpointDef] of Object.entries(schema.endpoints)) {
        if (endpointDef.implicit) continue; // implicit endpoint = owner, already indexed
        const refValue = entry.fields[endpointName];
        if (typeof refValue === "string") {
          const resolvedRef = this.resolveToId(refValue);
          let refCollections = this.endpointIndex.get(resolvedRef);
          if (!refCollections) {
            refCollections = new Map();
            this.endpointIndex.set(resolvedRef, refCollections);
          }
          let refEntries = refCollections.get(collectionName);
          if (!refEntries) {
            refEntries = [];
            refCollections.set(collectionName, refEntries);
          }
          refEntries.push(entry);
        }
      }
    }
  }

  // ── Entity queries ─────────────────────────────────────────────────

  /**
   * Look up an entity by its ID (stable 10-char) or slug.
   * Tries ID first, then falls back to slug lookup.
   */
  getEntity(idOrSlug: string): Entity | undefined {
    const byId = this.entities.get(idOrSlug);
    if (byId) return byId;
    const entityId = this.slugIndex.get(idOrSlug);
    return entityId ? this.entities.get(entityId) : undefined;
  }

  /** Look up an entity by slug only. */
  getEntityBySlug(slug: string): Entity | undefined {
    const entityId = this.slugIndex.get(slug);
    return entityId ? this.entities.get(entityId) : undefined;
  }

  /**
   * @deprecated Use `getEntity()` instead (it now accepts stableIds directly).
   */
  getEntityByStableId(stableId: string): Entity | undefined {
    return this.getEntity(stableId);
  }

  /**
   * Resolve an entity ID to its slug. Returns undefined if not found.
   * Also accepts slugs (returns the slug itself).
   */
  resolveSlug(idOrSlug: string): string | undefined {
    const entity = this.getEntity(idOrSlug);
    return entity?.slug;
  }

  /**
   * @deprecated Use `resolveSlug()` instead.
   */
  resolveStableId(stableId: string): string | undefined {
    return this.resolveSlug(stableId);
  }

  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  getByType(type: string): Entity[] {
    return Array.from(this.entities.values()).filter((t) => t.type === type);
  }

  // ── Fact queries ───────────────────────────────────────────────────

  getFacts(entityIdOrSlug: string, query?: FactQuery): Fact[] {
    const entityId = this.resolveToId(entityIdOrSlug);
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
  getLatest(entityIdOrSlug: string, propertyId: string): Fact | undefined {
    const facts = this.getFacts(entityIdOrSlug, { property: propertyId });
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
  getRelated(entityIdOrSlug: string, propertyId: string): string[] {
    const facts = this.getFacts(entityIdOrSlug, { property: propertyId });
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

  // ── Record queries ──────────────────────────────────────────────────

  getRecordSchema(id: string): RecordSchema | undefined {
    return this.recordSchemas.get(id);
  }

  getAllRecordSchemas(): RecordSchema[] {
    return Array.from(this.recordSchemas.values());
  }

  /**
   * Get record entries for a collection owned by an entity.
   * This is the primary index query (analogous to getItems).
   */
  getRecords(entityIdOrSlug: string, collectionName: string): RecordEntry[] {
    const entityId = this.resolveToId(entityIdOrSlug);
    return this.records.get(entityId)?.get(collectionName) ?? [];
  }

  /**
   * Get all collection names that have records for an entity.
   */
  getRecordCollectionNames(entityIdOrSlug: string): string[] {
    const entityId = this.resolveToId(entityIdOrSlug);
    const entityCollections = this.records.get(entityId);
    if (!entityCollections) return [];
    return Array.from(entityCollections.keys());
  }

  /**
   * Get all record collections for an entity as a map.
   */
  getAllRecordCollections(entityIdOrSlug: string): Map<string, RecordEntry[]> {
    const entityId = this.resolveToId(entityIdOrSlug);
    return this.records.get(entityId) ?? new Map();
  }

  /**
   * Get records that reference an entity via an explicit endpoint.
   * If collectionName is given, only returns records from that collection.
   * Otherwise returns all records referencing this entity.
   */
  getRecordsReferencing(
    entityIdOrSlug: string,
    collectionName?: string,
  ): RecordEntry[] {
    const entityId = this.resolveToId(entityIdOrSlug);
    const refCollections = this.endpointIndex.get(entityId);
    if (!refCollections) return [];

    if (collectionName) {
      return refCollections.get(collectionName) ?? [];
    }

    const results: RecordEntry[] = [];
    for (const entries of refCollections.values()) {
      results.push(...entries);
    }
    return results;
  }

  /**
   * Get all records of a given schema type across all entities.
   * Scans the primary index. For cross-entity dashboards.
   */
  getAllRecordsOfType(schemaId: string): RecordEntry[] {
    const results: RecordEntry[] = [];
    for (const entityCollections of this.records.values()) {
      for (const [, entries] of entityCollections) {
        for (const entry of entries) {
          if (entry.schema === schemaId) {
            results.push(entry);
          }
        }
      }
    }
    return results;
  }
}
