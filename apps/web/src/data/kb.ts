/**
 * KB data access layer.
 *
 * Reads the `kb` field from database.json (populated by build-data.mjs).
 * The KB data may not exist if build-data hasn't been wired up yet,
 * so all accessors return undefined/empty gracefully.
 */

import { getDatabase } from "@data";
import type { Fact, Property, Entity, TypeSchema, ItemEntry, RecordEntry, RecordSchema } from "@longterm-wiki/kb";
import type { SerializedKB } from "@longterm-wiki/kb";

function getKB(): SerializedKB | undefined {
  try {
    const db = getDatabase();
    return db.kb;
  } catch {
    return undefined;
  }
}

/** Sort facts most-recent-first by asOf (undefined asOf sorts last). */
function sortByAsOfDesc(facts: Fact[]): Fact[] {
  return facts.slice().sort((a, b) => {
    if (a.asOf === undefined && b.asOf === undefined) return 0;
    if (a.asOf === undefined) return 1;
    if (b.asOf === undefined) return -1;
    return b.asOf.localeCompare(a.asOf);
  });
}

/** Lazy-initialized index: factId → Fact. Built once on first call. */
let factByIdIndex: Map<string, Fact> | undefined;

/**
 * Look up a single fact by its ID (e.g. "f_dW5cR9mJ8q").
 * Uses a lazy-built index for O(1) lookups after initial build.
 */
export function getKBFactById(factId: string): Fact | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  if (!factByIdIndex) {
    factByIdIndex = new Map();
    for (const facts of Object.values(kb.facts)) {
      for (const f of facts) {
        factByIdIndex.set(f.id, f);
      }
    }
  }
  return factByIdIndex.get(factId);
}

/**
 * Get all facts for an entity, optionally filtered by property.
 * Returns facts sorted most-recent-first (by asOf).
 */
export function getKBFacts(entity: string, property?: string): Fact[] {
  const kb = getKB();
  if (!kb) return [];

  const facts = kb.facts[entity] ?? [];
  const filtered = property
    ? facts.filter((f) => f.propertyId === property)
    : facts;

  return sortByAsOfDesc(filtered);
}

/**
 * Check whether a fact has expired based on its validEnd field.
 * A fact is expired if validEnd is set AND validEnd < today's date.
 * Supports YYYY, YYYY-MM, and YYYY-MM-DD formats.
 * Facts without validEnd are never expired.
 */
export function isFactExpired(fact: Fact): boolean {
  if (!fact.validEnd) return false;
  // Pad partial dates so comparison works: "2024" → "2024-01-01", "2024-06" → "2024-06-01"
  const parts = fact.validEnd.split("-");
  const padded =
    parts.length === 1
      ? `${parts[0]}-01-01`
      : parts.length === 2
        ? `${parts[0]}-${parts[1]}-01`
        : fact.validEnd;
  const today = new Date().toISOString().slice(0, 10);
  return padded < today;
}

/**
 * Get the latest (most recent by asOf) fact for an entity + property.
 * By default, excludes expired facts (those with a validEnd in the past).
 * Set includeExpired=true to return expired facts as well.
 */
export function getKBLatest(
  entity: string,
  property: string,
  options?: { includeExpired?: boolean },
): Fact | undefined {
  const facts = getKBFacts(entity, property);
  if (options?.includeExpired) {
    return facts[0]; // Already sorted most-recent-first
  }
  return facts.find((f) => !isFactExpired(f));
}

/**
 * Get item entries for a named collection on an entity.
 */
export function getKBItems(entity: string, collection: string): ItemEntry[] {
  const kb = getKB();
  if (!kb) return [];

  return kb.items[entity]?.[collection] ?? [];
}

/**
 * Get all item collections for an entity.
 * Returns a map of collection name → ItemEntry[].
 */
export function getKBAllItemCollections(
  entity: string,
): Record<string, ItemEntry[]> {
  const kb = getKB();
  if (!kb) return {};

  // Return a shallow copy to avoid exposing the mutable cache reference
  return { ...(kb.items[entity] ?? {}) };
}

/**
 * Get a property definition by ID.
 */
export function getKBProperty(propertyId: string): Property | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  return kb.properties.find((p) => p.id === propertyId);
}

/**
 * Get an entity definition by ID.
 */
export function getKBEntity(entityId: string): Entity | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  return kb.entities.find((t: Entity) => t.id === entityId);
}

/**
 * Get all KB entities.
 */
export function getKBEntities(): Entity[] {
  const kb = getKB();
  if (!kb) return [];

  return kb.entities;
}

/**
 * Get all KB properties.
 */
export function getKBProperties(): Property[] {
  const kb = getKB();
  if (!kb) return [];

  return kb.properties;
}

/** @deprecated Use getKBEntity instead */
export const getKBThing = getKBEntity;

/**
 * Verification verdict values that can be returned by getKBFactVerification.
 * Matches the accuracy verdicts from the citation system plus 'verified'
 * (source quote verified but not accuracy-checked).
 */
export type KBFactVerdict =
  | "accurate"
  | "minor_issues"
  | "inaccurate"
  | "unsupported"
  | "not_verifiable"
  | "verified";

const VALID_VERDICTS: Set<string> = new Set([
  "accurate",
  "minor_issues",
  "inaccurate",
  "unsupported",
  "not_verifiable",
  "verified",
]);

/**
 * Get the citation verification status for a KB fact.
 * Returns the best verdict found by cross-referencing the fact's source URL
 * against citation quotes at build time, or undefined if no match.
 */
export function getKBFactVerification(factId: string): KBFactVerdict | undefined {
  try {
    const db = getDatabase();
    const verdict = db.kbFactVerification?.[factId];
    if (!verdict || !VALID_VERDICTS.has(verdict)) return undefined;
    return verdict as KBFactVerdict;
  } catch {
    return undefined;
  }
}

/**
 * Get the latest fact for a given property across all entities.
 * Returns a map of entityId → latest Fact for entities that have the property.
 * Optionally filtered to a subset of entity IDs.
 * By default, excludes expired facts (those with a validEnd in the past).
 */
export function getKBFactsByProperty(
  propertyId: string,
  entityIds?: string[],
  options?: { includeExpired?: boolean },
): Map<string, Fact> {
  const kb = getKB();
  if (!kb) return new Map();

  const ids = entityIds ?? kb.entities.map((e) => e.id);
  const result = new Map<string, Fact>();

  for (const entityId of ids) {
    const fact = getKBLatest(entityId, propertyId, options);
    if (fact) result.set(entityId, fact);
  }

  return result;
}

/**
 * Get all facts for a given property across all entities (full history).
 * Returns a map of entityId → Fact[] (sorted most-recent-first).
 * Optionally filtered to a subset of entity IDs.
 * By default, excludes expired facts (those with a validEnd in the past).
 */
export function getKBAllFactsByProperty(
  propertyId: string,
  entityIds?: string[],
  options?: { includeExpired?: boolean },
): Map<string, Fact[]> {
  const kb = getKB();
  if (!kb) return new Map();

  const ids = entityIds ?? kb.entities.map((e) => e.id);
  const result = new Map<string, Fact[]>();

  for (const entityId of ids) {
    let facts = getKBFacts(entityId, propertyId);
    if (!options?.includeExpired) {
      facts = facts.filter((f) => !isFactExpired(f));
    }
    if (facts.length > 0) result.set(entityId, facts);
  }

  return result;
}

/**
 * Get a type schema by type name.
 */
export function getKBSchema(type: string): TypeSchema | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  return kb.schemas.find((s) => s.type === type);
}

// ── Record access (unified records with schema-defined endpoints) ────

/**
 * Get record entries for a named collection on an entity (primary index).
 */
export function getKBRecords(entity: string, collection: string): RecordEntry[] {
  const kb = getKB();
  if (!kb) return [];
  return kb.records?.[entity]?.[collection] ?? [];
}

/**
 * Get all record collections for an entity.
 */
export function getKBAllRecordCollections(entity: string): Record<string, RecordEntry[]> {
  const kb = getKB();
  if (!kb) return {};
  return { ...(kb.records?.[entity] ?? {}) };
}

/**
 * Get a record schema by ID.
 */
export function getKBRecordSchema(schemaId: string): RecordSchema | undefined {
  const kb = getKB();
  if (!kb) return undefined;
  return kb.recordSchemas?.find((s) => s.id === schemaId);
}

/**
 * Get all record schemas.
 */
export function getKBRecordSchemas(): RecordSchema[] {
  const kb = getKB();
  if (!kb) return [];
  return kb.recordSchemas ?? [];
}

/**
 * Find all records across all entities that reference the given entityId
 * via an explicit endpoint field. Optionally filter by collection name.
 *
 * This is the serialized equivalent of Graph.getRecordsReferencing().
 * Scans all records and checks explicit endpoint fields using record schemas.
 */
export function getKBRecordsReferencing(
  entityId: string,
  collectionName?: string,
): RecordEntry[] {
  const kb = getKB();
  if (!kb || !kb.records || !kb.recordSchemas) return [];

  // Build schema Map for O(1) lookups instead of linear scan per entry
  const schemaMap = new Map(kb.recordSchemas.map((s) => [s.id, s]));

  const results: RecordEntry[] = [];

  for (const [, collections] of Object.entries(kb.records)) {
    for (const [colName, entries] of Object.entries(collections)) {
      if (collectionName && colName !== collectionName) continue;
      for (const entry of entries) {
        const schema = schemaMap.get(entry.schema);
        if (!schema) continue;
        for (const [endpointName, endpointDef] of Object.entries(schema.endpoints)) {
          if (endpointDef.implicit) continue;
          if (entry.fields[endpointName] === entityId) {
            results.push(entry);
            break; // Don't add same entry twice
          }
        }
      }
    }
  }

  return results;
}

/**
 * Get all item entries across all entities as a flat list.
 * Returns [entityId, collectionName, ItemEntry] tuples.
 */
export function getAllKBItems(): Array<{
  entityId: string;
  collection: string;
  entry: ItemEntry;
}> {
  const kb = getKB();
  if (!kb) return [];

  const results: Array<{
    entityId: string;
    collection: string;
    entry: ItemEntry;
  }> = [];

  for (const [entityId, collections] of Object.entries(kb.items)) {
    for (const [collectionName, entries] of Object.entries(collections)) {
      for (const entry of entries) {
        results.push({ entityId, collection: collectionName, entry });
      }
    }
  }

  return results;
}

/**
 * Look up a single item entry by its key (globally unique).
 * Returns the item along with its owner entity ID and collection name.
 */
export function getKBItemByKey(
  itemKey: string,
): { entityId: string; collection: string; entry: ItemEntry } | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  for (const [entityId, collections] of Object.entries(kb.items)) {
    for (const [collectionName, entries] of Object.entries(collections)) {
      for (const entry of entries) {
        if (entry.key === itemKey) {
          return { entityId, collection: collectionName, entry };
        }
      }
    }
  }
  return undefined;
}

/**
 * Find all item entries across all entities that reference the given entityId.
 * Scans item fields for string matches against the entityId.
 * Uses schema field definitions when available to identify ref-type fields.
 */
export function getKBItemsMentioning(
  entityId: string
): Array<{
  ownerEntityId: string;
  ownerName: string;
  collection: string;
  entry: ItemEntry;
  matchingFields: string[];
}> {
  const kb = getKB();
  if (!kb) return [];

  const results: Array<{
    ownerEntityId: string;
    ownerName: string;
    collection: string;
    entry: ItemEntry;
    matchingFields: string[];
  }> = [];

  for (const [ownerEntityId, collections] of Object.entries(kb.items)) {
    if (ownerEntityId === entityId) continue; // Skip self

    const ownerEntity = kb.entities.find((t: Entity) => t.id === ownerEntityId);
    const schema = ownerEntity
      ? kb.schemas.find((s) => s.type === ownerEntity.type)
      : undefined;

    for (const [collectionName, entries] of Object.entries(collections)) {
      const fieldDefs = schema?.items?.[collectionName]?.fields;

      for (const entry of entries) {
        const matchingFields: string[] = [];

        for (const [fieldName, fieldValue] of Object.entries(entry.fields)) {
          const fieldDef = fieldDefs?.[fieldName];

          if (fieldDef?.type === "ref" && fieldValue === entityId) {
            matchingFields.push(fieldName);
          } else if (
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
            ownerName: ownerEntity?.name ?? ownerEntityId,
            collection: collectionName,
            entry,
            matchingFields,
          });
        }
      }
    }
  }

  return results;
}
