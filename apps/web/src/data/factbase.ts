/**
 * FactBase data access layer.
 *
 * Reads factbase-data.json (populated by build-data.mjs) — a dedicated file
 * split out from database.json for faster incremental builds and smaller
 * main database bundle.
 *
 * The FactBase data may not exist if build-data hasn't been wired up yet,
 * so all accessors return undefined/empty gracefully.
 */

import fs from "fs";
import path from "path";
import { getDatabase } from "@data";
import type { Fact, Property, Entity, RecordEntry, RecordSchema } from "@longterm-wiki/factbase";
import type { SerializedKB } from "@longterm-wiki/factbase";

const LOCAL_DATA_DIR = path.resolve(process.cwd(), "src/data");

let _factbaseData: SerializedKB | undefined | null = null; // null = not yet loaded

/** Get the full serialized FactBase data (or undefined if not available). */
export function getFactBase(): SerializedKB | undefined {
  if (_factbaseData !== null) return _factbaseData;

  const factbasePath = path.join(LOCAL_DATA_DIR, "factbase-data.json");
  try {
    const raw = fs.readFileSync(factbasePath, "utf-8");
    _factbaseData = JSON.parse(raw) as SerializedKB;
  } catch {
    _factbaseData = undefined;
  }
  return _factbaseData;
}


/**
 * Resolve an entity identifier to the entity ID used as key in facts/records.
 * Accepts either an entity ID (10-char alphanumeric) or a YAML filename/slug.
 * MDX components pass slugs like "anthropic"; entity pages pass IDs like "mK9pX3rQ7n".
 */
function resolveEntityKey(entityOrSlug: string, fb?: SerializedKB): string {
  const resolved = fb ?? getFactBase();
  if (!resolved?.slugToEntityId) return entityOrSlug;
  // If it's a slug, resolve to entity ID; otherwise return as-is (already an ID)
  return resolved.slugToEntityId[entityOrSlug] ?? entityOrSlug;
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
export function getFactBaseFactById(factId: string): Fact | undefined {
  const fb = getFactBase();
  if (!fb) return undefined;

  if (!factByIdIndex) {
    factByIdIndex = new Map();
    for (const facts of Object.values(fb.facts)) {
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
export function getFactBaseFacts(entity: string, property?: string): Fact[] {
  const fb = getFactBase();
  if (!fb) return [];

  const key = resolveEntityKey(entity, fb);
  const facts = fb.facts[key] ?? [];
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
export function getFactBaseLatest(
  entity: string,
  property: string,
  options?: { includeExpired?: boolean },
): Fact | undefined {
  const facts = getFactBaseFacts(entity, property);
  if (options?.includeExpired) {
    return facts[0]; // Already sorted most-recent-first
  }
  return facts.find((f) => !isFactExpired(f));
}

/** Lazy-initialized index: propertyId → Property. Built once on first call. */
let propertyByIdIndex: Map<string, Property> | undefined;

/**
 * Get a property definition by ID.
 * Uses a lazy-built index for O(1) lookups after initial build.
 */
export function getFactBaseProperty(propertyId: string): Property | undefined {
  const fb = getFactBase();
  if (!fb) return undefined;

  if (!propertyByIdIndex) {
    propertyByIdIndex = new Map();
    for (const p of fb.properties) {
      propertyByIdIndex.set(p.id, p);
    }
  }
  return propertyByIdIndex.get(propertyId);
}

/** Lazy-initialized index: entityId → Entity. Built once on first call. */
let entityByIdIndex: Map<string, Entity> | undefined;

/**
 * Get an entity definition by ID or slug.
 * Accepts either an internal entity ID (e.g. "mK9pX3rQ7n") or a YAML slug
 * (e.g. "anthropic"). Uses a lazy-built index for O(1) lookups after initial build.
 */
export function getFactBaseEntity(entityId: string): Entity | undefined {
  const fb = getFactBase();
  if (!fb) return undefined;

  if (!entityByIdIndex) {
    entityByIdIndex = new Map();
    for (const e of fb.entities) {
      entityByIdIndex.set(e.id, e);
    }
  }
  // Try direct ID lookup first, then resolve as slug
  const direct = entityByIdIndex.get(entityId);
  if (direct) return direct;
  const resolvedId = resolveEntityKey(entityId, fb);
  return resolvedId !== entityId ? entityByIdIndex.get(resolvedId) : undefined;
}

/**
 * Get all FactBase entities.
 */
export function getFactBaseEntities(): Entity[] {
  const fb = getFactBase();
  if (!fb) return [];

  return fb.entities;
}

/**
 * Get all FactBase properties.
 */
export function getFactBaseProperties(): Property[] {
  const fb = getFactBase();
  if (!fb) return [];

  return fb.properties;
}

/**
 * Verification verdict values that can be returned by getFactBaseFactVerification.
 * Matches the accuracy verdicts from the citation system plus 'verified'
 * (source quote verified but not accuracy-checked).
 */
export type FactBaseVerdict =
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
 * Get the citation verification status for a FactBase fact.
 * Returns the best verdict found by cross-referencing the fact's source URL
 * against citation quotes at build time, or undefined if no match.
 */
export function getFactBaseFactVerification(factId: string): FactBaseVerdict | undefined {
  try {
    const db = getDatabase();
    const verdict = db.kbFactVerification?.[factId];
    if (!verdict || !VALID_VERDICTS.has(verdict)) return undefined;
    return verdict as FactBaseVerdict;
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
export function getFactBaseFactsByProperty(
  propertyId: string,
  entityIds?: string[],
  options?: { includeExpired?: boolean },
): Map<string, Fact> {
  const fb = getFactBase();
  if (!fb) return new Map();

  const ids = entityIds ?? fb.entities.map((e) => e.id);
  const result = new Map<string, Fact>();

  for (const entityId of ids) {
    const fact = getFactBaseLatest(entityId, propertyId, options);
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
export function getFactBaseAllFactsByProperty(
  propertyId: string,
  entityIds?: string[],
  options?: { includeExpired?: boolean },
): Map<string, Fact[]> {
  const fb = getFactBase();
  if (!fb) return new Map();

  const ids = entityIds ?? fb.entities.map((e) => e.id);
  const result = new Map<string, Fact[]>();

  for (const entityId of ids) {
    let facts = getFactBaseFacts(entityId, propertyId);
    if (!options?.includeExpired) {
      facts = facts.filter((f) => !isFactExpired(f));
    }
    if (facts.length > 0) result.set(entityId, facts);
  }

  return result;
}

// ── Records access ────────────────────────────────────────────────

/**
 * A single record entry from the FactBase records system.
 * Records are structured data items (grants, funding rounds, etc.)
 * stored per-entity, per-collection in factbase-data.json.
 * Populated from PostgreSQL during build-data.
 */
export interface FactBaseRecordEntry {
  key: string;
  schema: string;
  ownerEntityId: string;
  fields: Record<string, unknown>;
  /** Display name for non-entity participants (when allow_display_name is true) */
  displayName?: string;
}

/**
 * Get all records for an entity in a specific collection.
 * Returns an empty array if no records exist.
 *
 * The records field is added to factbase-data.json by build-data.mjs (merged from PG).
 * It is NOT part of the SerializedKB TypeScript type (which only covers
 * entities/facts/properties/schemas), so we access it via type assertion.
 */
export function getFactBaseRecords(entityId: string, collection: string): FactBaseRecordEntry[] {
  const fb = getFactBase();
  if (!fb) return [];

  const key = resolveEntityKey(entityId, fb);
  // records is added dynamically by build-data.mjs, not in SerializedKB type
  type RecordsMap = Record<string, Record<string, FactBaseRecordEntry[]>>;
  const records = "records" in fb
    ? (fb as { records?: RecordsMap }).records
    : undefined;
  if (!records) return [];

  return records[key]?.[collection] ?? [];
}

/**
 * Get all record collections for an entity.
 */
export function getFactBaseAllRecordCollections(entity: string): Record<string, FactBaseRecordEntry[]> {
  const fb = getFactBase();
  if (!fb) return {};

  const key = resolveEntityKey(entity, fb);
  type RecordsMap = Record<string, Record<string, FactBaseRecordEntry[]>>;
  const records = "records" in fb
    ? (fb as { records?: RecordsMap }).records
    : undefined;
  if (!records) return {};

  return { ...(records[key] ?? {}) };
}

/** Module-level cache for getAllFactBaseRecords results (FactBase data is static at build time). */
const _allRecordsCache = new Map<string, FactBaseRecordEntry[]>();

/**
 * Get all records across all entities for a specific collection.
 * Returns a flat array of all record entries.
 */
export function getAllFactBaseRecords(collection: string): FactBaseRecordEntry[] {
  const cached = _allRecordsCache.get(collection);
  if (cached) return cached;

  const fb = getFactBase();
  if (!fb) return [];

  type RecordsMap = Record<string, Record<string, FactBaseRecordEntry[]>>;
  const records = "records" in fb
    ? (fb as { records?: RecordsMap }).records
    : undefined;
  if (!records) return [];

  const result: FactBaseRecordEntry[] = [];
  for (const entityRecords of Object.values(records)) {
    const collectionRecords = entityRecords[collection];
    if (collectionRecords) {
      result.push(...collectionRecords);
    }
  }
  _allRecordsCache.set(collection, result);
  return result;
}

/**
 * Get all records across all entities for a specific collection name.
 * Returns a flat array of record entries (convenience alias).
 */
export function getAllFactBaseRecordsByCollection(collection: string): FactBaseRecordEntry[] {
  return getAllFactBaseRecords(collection);
}

/**
 * Get a record schema by ID.
 */
export function getFactBaseRecordSchema(schemaId: string): RecordSchema | undefined {
  const fb = getFactBase();
  if (!fb) return undefined;
  return fb.recordSchemas?.find((s: RecordSchema) => s.id === schemaId);
}

/**
 * Get all record schemas.
 */
export function getFactBaseRecordSchemas(): RecordSchema[] {
  const fb = getFactBase();
  if (!fb) return [];
  return fb.recordSchemas ?? [];
}

/**
 * Find all records across all entities that reference the given entityId
 * via an explicit endpoint field. Optionally filter by collection name.
 */
export function getFactBaseRecordsReferencing(
  entityId: string,
  collectionName?: string,
): RecordEntry[] {
  const fb = getFactBase();
  if (!fb || !fb.records || !fb.recordSchemas) return [];

  const schemaMap = new Map(fb.recordSchemas.map((s: RecordSchema) => [s.id, s]));
  const results: RecordEntry[] = [];

  for (const [, collections] of Object.entries(fb.records)) {
    for (const [colName, entries] of Object.entries(collections)) {
      if (collectionName && colName !== collectionName) continue;
      for (const entry of entries) {
        const schema = schemaMap.get(entry.schema);
        if (!schema) continue;
        for (const [endpointName, endpointDef] of Object.entries(schema.endpoints)) {
          if (endpointDef.implicit) continue;
          if (entry.fields[endpointName] === entityId) {
            results.push(entry);
            break;
          }
        }
      }
    }
  }

  return results;
}

/**
 * Look up a single record entry by its key.
 */
export function getFactBaseRecordByKey(
  recordKey: string,
): { entityId: string; collection: string; entry: RecordEntry } | undefined {
  const fb = getFactBase();
  if (!fb || !fb.records) return undefined;

  for (const [entityId, collections] of Object.entries(fb.records)) {
    for (const [collectionName, entries] of Object.entries(collections)) {
      for (const entry of entries) {
        if (entry.key === recordKey) {
          return { entityId, collection: collectionName, entry };
        }
      }
    }
  }
  return undefined;
}

/**
 * Get all record entries across all entities as a flat list.
 * Returns entries wrapped with their entityId and collection name.
 */
export function getAllFactBaseRecordEntries(): Array<{
  entityId: string;
  collection: string;
  entry: RecordEntry;
}> {
  const fb = getFactBase();
  if (!fb || !fb.records) return [];

  const results: Array<{
    entityId: string;
    collection: string;
    entry: RecordEntry;
  }> = [];

  for (const [entityId, collections] of Object.entries(fb.records)) {
    for (const [collectionName, entries] of Object.entries(collections)) {
      for (const entry of entries) {
        results.push({ entityId, collection: collectionName, entry });
      }
    }
  }

  return results;
}

// ── Slug resolution (public) ─────────────────────────────────────

/**
 * Resolve a YAML filename slug (e.g. "anthropic") to a FactBase entity ID.
 * Returns undefined if the slug is not in the mapping.
 */
export function resolveFactBaseSlug(slug: string): string | undefined {
  const fb = getFactBase();
  if (!fb?.slugToEntityId) return undefined;
  return fb.slugToEntityId[slug];
}

/**
 * Get the full slug→entityId mapping.
 * Useful for building static params or reverse lookups.
 */
export function getFactBaseSlugMap(): Record<string, string> {
  const fb = getFactBase();
  return fb?.slugToEntityId ?? {};
}

/**
 * Resolve a previous slug to the current canonical slug.
 * Returns the current slug if the input is a known previous slug, or undefined.
 * Used for URL redirect support when entity slugs change.
 */
export function resolveSlugAlias(slug: string): string | undefined {
  const fb = getFactBase();
  if (!fb?.previousSlugToCurrentSlug) return undefined;
  return fb.previousSlugToCurrentSlug[slug];
}

/** Lazy-initialized inverted index: entityId → slug. Built once on first call. */
let entityIdToSlugIndex: Map<string, string> | undefined;

/**
 * Reverse lookup: find the YAML slug for a given entity ID.
 * Uses a lazy-built inverted index for O(1) lookups.
 */
export function getFactBaseEntitySlug(entityId: string): string | undefined {
  if (!entityIdToSlugIndex) {
    const map = getFactBaseSlugMap();
    entityIdToSlugIndex = new Map();
    for (const [slug, id] of Object.entries(map)) {
      entityIdToSlugIndex.set(id, slug);
    }
  }
  return entityIdToSlugIndex.get(entityId);
}

// ── Backwards compatibility aliases ─────────────────────────────
// These aliases allow consumers to migrate incrementally.
// TODO: Remove after all call sites are updated.

/** @deprecated Use getFactBase() */
export const getKB = getFactBase;
/** @deprecated Use getFactBaseFactById() */
export const getKBFactById = getFactBaseFactById;
/** @deprecated Use getFactBaseFacts() */
export const getKBFacts = getFactBaseFacts;
/** @deprecated Use getFactBaseLatest() */
export const getKBLatest = getFactBaseLatest;
/** @deprecated Use getFactBaseProperty() */
export const getKBProperty = getFactBaseProperty;
/** @deprecated Use getFactBaseEntity() */
export const getKBEntity = getFactBaseEntity;
/** @deprecated Use getFactBaseEntities() */
export const getKBEntities = getFactBaseEntities;
/** @deprecated Use getFactBaseProperties() */
export const getKBProperties = getFactBaseProperties;
/** @deprecated Use getFactBaseFactVerification() */
export const getKBFactVerification = getFactBaseFactVerification;
/** @deprecated Use getFactBaseFactsByProperty() */
export const getKBFactsByProperty = getFactBaseFactsByProperty;
/** @deprecated Use getFactBaseAllFactsByProperty() */
export const getKBAllFactsByProperty = getFactBaseAllFactsByProperty;
/** @deprecated Use getFactBaseRecords() */
export const getKBRecords = getFactBaseRecords;
/** @deprecated Use getFactBaseAllRecordCollections() */
export const getKBAllRecordCollections = getFactBaseAllRecordCollections;
/** @deprecated Use getAllFactBaseRecords() */
export const getAllKBRecords = getAllFactBaseRecords;
/** @deprecated Use getAllFactBaseRecordsByCollection() */
export const getAllKBRecordsByCollection = getAllFactBaseRecordsByCollection;
/** @deprecated Use getFactBaseRecordSchema() */
export const getKBRecordSchema = getFactBaseRecordSchema;
/** @deprecated Use getFactBaseRecordSchemas() */
export const getKBRecordSchemas = getFactBaseRecordSchemas;
/** @deprecated Use getFactBaseRecordsReferencing() */
export const getKBRecordsReferencing = getFactBaseRecordsReferencing;
/** @deprecated Use getFactBaseRecordByKey() */
export const getKBRecordByKey = getFactBaseRecordByKey;
/** @deprecated Use getAllFactBaseRecordEntries() */
export const getAllKBRecordEntries = getAllFactBaseRecordEntries;
/** @deprecated Use resolveFactBaseSlug() */
export const resolveKBSlug = resolveFactBaseSlug;
/** @deprecated Use getFactBaseSlugMap() */
export const getKBSlugMap = getFactBaseSlugMap;
/** @deprecated Use getFactBaseEntitySlug() */
export const getKBEntitySlug = getFactBaseEntitySlug;
/** @deprecated Use FactBaseVerdict */
export type KBFactVerdict = FactBaseVerdict;
/** @deprecated Use FactBaseRecordEntry */
export type KBRecordEntry = FactBaseRecordEntry;
