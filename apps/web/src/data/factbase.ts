/**
 * FactBase — Structured facts data access layer.
 *
 * This module is the "FactBase" layer of the wiki's Three Bases architecture:
 *   - **TableBase** (tablebase.ts): Typed relational records (entities, resources).
 *   - **FactBase** (this file): Structured triples with temporal data, provenance,
 *     and cross-entity references. Source of truth: YAML files in
 *     packages/factbase/data/things/ (NOT the PG `facts` table, which is a read mirror).
 *   - **WikiBase**: Long-form prose MDX articles (content/docs/).
 *
 * Naming note: The "things" directory in packages/factbase/data/things/ contains
 * FactBase entity YAML files. This is NOT related to the PG `things` table, which
 * is a cross-base universal index. See content/docs/internal/data-architecture.mdx.
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
import { getIdRegistry, getTypedEntityByStableId, getTypedEntities } from "@/data/tablebase";
import type { Fact, Property, Entity } from "@longterm-wiki/factbase";
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
 *
 * Resolution: idRegistry stableIdBySlug → identity (pass-through if already a stableId).
 */
function resolveEntityKey(entityOrSlug: string): string {
  // Use idRegistry from TableBase (covers all entities)
  try {
    const registry = getIdRegistry();
    const stableId = registry.stableIdBySlug?.[entityOrSlug];
    if (stableId) return stableId;
  } catch {
    // database.json not available yet (during build) — ignore
  }
  return entityOrSlug;
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

  const key = resolveEntityKey(entity);
  const facts = fb.facts[key] ?? [];
  const filtered = property
    ? facts.filter((f) => f.propertyId === property)
    : facts;

  return sortByAsOfDesc(filtered);
}

/**
 * Pad a partial date string to YYYY-MM-DD for lexicographic comparison.
 * "2024" → "2024-01-01", "2024-06" → "2024-06-01", "2024-06-15" → "2024-06-15".
 */
function padDateToFull(date: string): string {
  const parts = date.split("-");
  if (parts.length === 1) return `${parts[0]}-01-01`;
  if (parts.length === 2) return `${parts[0]}-${parts[1]}-01`;
  return date;
}

/**
 * Check whether a fact has expired based on its validEnd field.
 * A fact is expired if validEnd is set AND validEnd < today's date.
 * Supports YYYY, YYYY-MM, and YYYY-MM-DD formats.
 * Facts without validEnd are never expired.
 */
export function isFactExpired(fact: Fact): boolean {
  if (!fact.validEnd) return false;
  const padded = padDateToFull(fact.validEnd);
  const today = new Date().toISOString().slice(0, 10);
  return padded < today;
}

/**
 * Check whether a fact's asOf date is in the future (after today).
 * A fact is future-dated if asOf is set AND asOf > today's date.
 * Supports YYYY, YYYY-MM, and YYYY-MM-DD formats.
 * Facts without asOf are never considered future-dated.
 */
export function isFactFutureDated(fact: Fact): boolean {
  if (!fact.asOf) return false;
  const padded = padDateToFull(fact.asOf);
  const today = new Date().toISOString().slice(0, 10);
  return padded > today;
}

/**
 * Get the latest (most recent by asOf) fact for an entity + property.
 * By default, excludes expired facts (those with a validEnd in the past)
 * and future-dated facts (those with an asOf after today).
 *
 * This prevents forecasts/targets (e.g., "2026 target gross margin: 63%")
 * from being returned over actual reported values (e.g., "2024 actual: 40%").
 *
 * If all facts are future-dated, falls back to the most recent one
 * (after expiry filtering) to avoid returning nothing.
 *
 * Set includeExpired=true to return expired facts as well.
 * Set includeFuture=true to include future-dated facts in selection.
 */
export function getFactBaseLatest(
  entity: string,
  property: string,
  options?: { includeExpired?: boolean; includeFuture?: boolean },
): Fact | undefined {
  const facts = getFactBaseFacts(entity, property);
  if (options?.includeExpired && options?.includeFuture) {
    return facts[0]; // Already sorted most-recent-first
  }

  // Apply expiry filter
  const afterExpiry = options?.includeExpired
    ? facts
    : facts.filter((f) => !isFactExpired(f));

  if (afterExpiry.length === 0) return undefined;

  // Apply future-date filter
  if (options?.includeFuture) {
    return afterExpiry[0];
  }

  const nonFuture = afterExpiry.filter((f) => !isFactFutureDated(f));
  // Fallback: if all remaining facts are future-dated, return the most recent
  // (closest to today) to avoid returning nothing
  if (nonFuture.length === 0) return afterExpiry[afterExpiry.length - 1];

  return nonFuture[0];
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

/**
 * Convert a TableBase AnyEntity to a FactBase Entity compat shim.
 * Maps TypedEntity fields to the FactBase Entity interface so existing callers
 * continue working without changes.
 */
function toFactBaseEntity(typed: { id: string; entityType: string; title: string; stableId?: string; wikiId?: string; aliases?: string[]; [key: string]: unknown }): Entity {
  return {
    id: typed.stableId ?? typed.id,
    type: typed.entityType,
    name: typed.title,
    stableId: typed.stableId ?? typed.id,
    wikiPageId: typed.wikiId,
    wikiId: typed.wikiId,
    ...(typed.aliases && typed.aliases.length > 0 && { aliases: typed.aliases }),
  };
}

/**
 * Get a FactBase entity definition by ID or slug.
 * Accepts either an internal entity ID (e.g. "mK9pX3rQ7n") or a YAML slug
 * (e.g. "anthropic"). Delegates to TableBase for entity data.
 *
 * Returns a compat shim mapping TableBase fields to the FactBase Entity interface.
 */
export function getFactBaseEntity(entityId: string): Entity | undefined {
  // Resolve the entityId — it might be a slug, stableId, or wikiId
  const resolvedId = resolveEntityKey(entityId);

  // Try to find in TableBase by stableId
  const typed = getTypedEntityByStableId(resolvedId);
  if (typed) return toFactBaseEntity(typed);

  // If the original ID is different from resolved, also try original as stableId
  if (resolvedId !== entityId) {
    const typedDirect = getTypedEntityByStableId(entityId);
    if (typedDirect) return toFactBaseEntity(typedDirect);
  }

  // Legacy fallback: try FactBase entities if they still exist in the data
  const fb = getFactBase();
  if (fb?.entities) {
    const found = fb.entities.find((e) => e.id === entityId || e.id === resolvedId);
    if (found) return found;
  }

  return undefined;
}

/**
 * Get all FactBase entities.
 * Delegates to TableBase's getTypedEntities() and returns compat shims.
 */
export function getFactBaseEntities(): Entity[] {
  try {
    return getTypedEntities().map(toFactBaseEntity);
  } catch {
    // Fallback: use FactBase entities if TableBase not available
    const fb = getFactBase();
    return fb?.entities ?? [];
  }
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

let _kbFactVerification: Record<string, string> | null = null;

function loadKbFactVerification(): Record<string, string> {
  if (_kbFactVerification) return _kbFactVerification;
  const filePath = path.join(LOCAL_DATA_DIR, "kb-fact-verification.json");
  try {
    _kbFactVerification = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return _kbFactVerification!;
  } catch {
    _kbFactVerification = {};
    return _kbFactVerification;
  }
}

/**
 * Get the citation verification status for a FactBase fact.
 * Returns the best verdict found by cross-referencing the fact's source URL
 * against citation quotes at build time, or undefined if no match.
 * Loaded from a separate kb-fact-verification.json (split from database.json).
 */
export function getFactBaseFactVerification(factId: string): FactBaseVerdict | undefined {
  const verifications = loadKbFactVerification();
  const verdict = verifications[factId];
  if (!verdict || !VALID_VERDICTS.has(verdict)) return undefined;
  return verdict as FactBaseVerdict;
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

  // Use provided entity IDs, or fall back to all entities that have facts
  const ids = entityIds ?? Object.keys(fb.facts);
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

  // Use provided entity IDs, or fall back to all entities that have facts
  const ids = entityIds ?? Object.keys(fb.facts);
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

  const key = resolveEntityKey(entityId);
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

  const key = resolveEntityKey(entity);
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
 * Get all unique record collection names present in factbase-data.json.
 * Derived dynamically from the data so new collections are picked up automatically.
 */
export function getFactBaseRecordCollectionNames(): string[] {
  const fb = getFactBase();
  if (!fb) return [];

  type RecordsMap = Record<string, Record<string, FactBaseRecordEntry[]>>;
  const records = "records" in fb
    ? (fb as { records?: RecordsMap }).records
    : undefined;
  if (!records) return [];

  const names = new Set<string>();
  for (const entityRecords of Object.values(records)) {
    for (const collectionName of Object.keys(entityRecords)) {
      names.add(collectionName);
    }
  }
  return Array.from(names);
}

/**
 * Record schema shape as previously loaded from KB YAML.
 * Record schemas are no longer part of the KB package (records migrated to PG),
 * but this type is kept for backward compatibility with components that
 * access the recordSchemas field in factbase-data.json.
 */
export interface FactBaseRecordSchema {
  id: string;
  name: string;
  description?: string;
  collectionName?: string;
  endpoints: Record<string, {
    types: string[];
    implicit?: boolean;
    required?: boolean;
    allowDisplayName?: boolean;
  }>;
  fields: Record<string, {
    type: string;
    required?: boolean;
    unit?: string;
    description?: string;
  }>;
  temporal?: boolean;
}

/**
 * Get a record schema by ID.
 * Note: Record schemas are no longer part of the KB serialization.
 * This returns undefined unless recordSchemas was injected into factbase-data.json
 * by build-data.mjs from another source.
 */
export function getFactBaseRecordSchema(schemaId: string): FactBaseRecordSchema | undefined {
  const fb = getFactBase();
  if (!fb) return undefined;
  // recordSchemas is not in SerializedKB type; access via type assertion
  const schemas = "recordSchemas" in fb
    ? (fb as { recordSchemas?: FactBaseRecordSchema[] }).recordSchemas
    : undefined;
  return schemas?.find((s) => s.id === schemaId);
}

/**
 * Get all record schemas.
 * Note: Record schemas were removed from KB serialization when records migrated
 * to PostgreSQL. build-data.mjs does not currently write recordSchemas into
 * factbase-data.json, so this returns [] unless a future build step adds them.
 * Callers handle the empty case gracefully.
 */
export function getFactBaseRecordSchemas(): FactBaseRecordSchema[] {
  const fb = getFactBase();
  if (!fb) return [];
  // recordSchemas is not in SerializedKB type; access via type assertion
  const schemas = "recordSchemas" in fb
    ? (fb as { recordSchemas?: FactBaseRecordSchema[] }).recordSchemas
    : undefined;
  return schemas ?? [];
}


// ── Slug resolution (public) ─────────────────────────────────────

/**
 * Resolve a YAML filename slug (e.g. "anthropic") to a FactBase entity ID (stableId).
 * Uses idRegistry from TableBase as primary source.
 * Returns undefined if the slug is not in the mapping.
 */
export function resolveFactBaseSlug(slug: string): string | undefined {
  try {
    const registry = getIdRegistry();
    return registry.stableIdBySlug?.[slug];
  } catch {
    // database.json not available yet
    return undefined;
  }
}

/**
 * Get the full slug→entityId mapping.
 * Uses idRegistry from TableBase as primary source.
 * Useful for building static params or reverse lookups.
 */
export function getFactBaseSlugMap(): Record<string, string> {
  try {
    const registry = getIdRegistry();
    if (registry.stableIdBySlug && Object.keys(registry.stableIdBySlug).length > 0) {
      return registry.stableIdBySlug;
    }
  } catch {
    // database.json not available yet
  }
  return {};
}

/**
 * Static slug aliases for FactBase filenames that differ from their
 * canonical TableBase slug. These are checked by resolveSlugAlias()
 * so that directory pages (e.g. /organizations/center-for-ai-safety)
 * redirect to the canonical slug (/organizations/cais).
 *
 * Add entries here when a FactBase YAML filename doesn't match
 * the TableBase entity id (the slug used in URLs).
 */
const STATIC_SLUG_ALIASES: Record<string, string> = {
  "center-for-ai-safety": "cais",
  "survival-and-flourishing-fund": "sff",
  "gpqa": "gpqa-diamond",
  "math": "math-benchmark",
  "mistral-large": "mistral-large-2",
  "alignment-research-center": "arc",
};

/**
 * Resolve a previous slug to the current canonical slug.
 * Returns the current slug if the input is a known previous slug, or undefined.
 * Used for URL redirect support when entity slugs change.
 */
export function resolveSlugAlias(slug: string): string | undefined {
  // Check static aliases first (FactBase filename → TableBase slug)
  const staticAlias = STATIC_SLUG_ALIASES[slug];
  if (staticAlias) return staticAlias;

  const fb = getFactBase();
  if (!fb?.previousSlugToCurrentSlug) return undefined;
  return fb.previousSlugToCurrentSlug[slug];
}

/**
 * Reverse lookup: find the YAML slug for a given entity ID (stableId).
 * Uses idRegistry from TableBase as primary source.
 */
export function getFactBaseEntitySlug(entityId: string): string | undefined {
  // Primary: idRegistry.stableIdToSlug or byStableId from TableBase
  try {
    const registry = getIdRegistry();
    const slug = registry.stableIdToSlug?.[entityId] ?? registry.byStableId?.[entityId];
    if (slug) return slug;

    // Check if the input is already a known slug (e.g. "us-aisi" passed
    // from a FactBase ref value that happens to be a slug, not a stableId)
    if (registry.stableIdBySlug?.[entityId]) return entityId;
  } catch {
    // database.json not available yet — fall through
  }
  // Legacy fallback: invert the slug map from FactBase
  const map = getFactBaseSlugMap();
  for (const [slug, id] of Object.entries(map)) {
    if (id === entityId) return slug;
  }
  return undefined;
}

// ── Backwards compatibility aliases ─────────────────────────────
// These aliases allow consumers to migrate incrementally.

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
