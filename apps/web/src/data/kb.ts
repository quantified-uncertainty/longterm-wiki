/**
 * KB data access layer.
 *
 * Reads kb-data.json (populated by build-data.mjs) — a dedicated file
 * split out from database.json for faster incremental builds and smaller
 * main database bundle.
 *
 * The KB data may not exist if build-data hasn't been wired up yet,
 * so all accessors return undefined/empty gracefully.
 */

import fs from "fs";
import path from "path";
import { getDatabase } from "@data";
import type { Fact, Property, Entity } from "@longterm-wiki/kb";
import type { SerializedKB } from "@longterm-wiki/kb";

const LOCAL_DATA_DIR = path.resolve(process.cwd(), "src/data");

let _kbData: SerializedKB | undefined | null = null; // null = not yet loaded

/** Get the full serialized KB data (or undefined if not available). */
export function getKB(): SerializedKB | undefined {
  if (_kbData !== null) return _kbData;

  const kbPath = path.join(LOCAL_DATA_DIR, "kb-data.json");
  try {
    const raw = fs.readFileSync(kbPath, "utf-8");
    _kbData = JSON.parse(raw) as SerializedKB;
  } catch {
    _kbData = undefined;
  }
  return _kbData;
}


/**
 * Resolve an entity identifier to the entity ID used as key in facts.
 * Accepts either an entity ID (10-char alphanumeric) or a YAML filename/slug.
 * MDX components pass slugs like "anthropic"; entity pages pass IDs like "mK9pX3rQ7n".
 */
function resolveEntityKey(entityOrSlug: string, kb?: SerializedKB): string {
  const resolved = kb ?? getKB();
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

  const key = resolveEntityKey(entity, kb);
  const facts = kb.facts[key] ?? [];
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

/** Lazy-initialized index: propertyId → Property. Built once on first call. */
let propertyByIdIndex: Map<string, Property> | undefined;

/**
 * Get a property definition by ID.
 * Uses a lazy-built index for O(1) lookups after initial build.
 */
export function getKBProperty(propertyId: string): Property | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  if (!propertyByIdIndex) {
    propertyByIdIndex = new Map();
    for (const p of kb.properties) {
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
export function getKBEntity(entityId: string): Entity | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  if (!entityByIdIndex) {
    entityByIdIndex = new Map();
    for (const e of kb.entities) {
      entityByIdIndex.set(e.id, e);
    }
  }
  // Try direct ID lookup first, then resolve as slug
  const direct = entityByIdIndex.get(entityId);
  if (direct) return direct;
  const resolvedId = resolveEntityKey(entityId, kb);
  return resolvedId !== entityId ? entityByIdIndex.get(resolvedId) : undefined;
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

// ── Records access ────────────────────────────────────────────────

/**
 * A single record entry from the KB records system.
 * Records are structured data items (grants, funding rounds, etc.)
 * stored per-entity, per-collection in kb-data.json.
 * Populated from PostgreSQL during build-data.
 */
export interface KBRecordEntry {
  key: string;
  schema: string;
  ownerEntityId: string;
  fields: Record<string, unknown>;
}

/**
 * Get all records for an entity in a specific collection.
 * Returns an empty array if no records exist.
 *
 * The records field is added to kb-data.json by build-data.mjs (merged from PG).
 * It is NOT part of the SerializedKB TypeScript type (which only covers
 * entities/facts/properties/schemas), so we access it via type assertion.
 */
export function getKBRecords(entityId: string, collection: string): KBRecordEntry[] {
  const kb = getKB();
  if (!kb) return [];

  const key = resolveEntityKey(entityId, kb);
  // records is added dynamically by build-data.mjs, not in SerializedKB type
  const records = (kb as Record<string, unknown>).records as
    | Record<string, Record<string, KBRecordEntry[]>>
    | undefined;
  if (!records) return [];

  return records[key]?.[collection] ?? [];
}

/**
 * Get all records across all entities for a specific collection.
 * Returns a flat array of all record entries.
 */
export function getAllKBRecords(collection: string): KBRecordEntry[] {
  const kb = getKB();
  if (!kb) return [];

  const records = (kb as Record<string, unknown>).records as
    | Record<string, Record<string, KBRecordEntry[]>>
    | undefined;
  if (!records) return [];

  const result: KBRecordEntry[] = [];
  for (const entityRecords of Object.values(records)) {
    const collectionRecords = entityRecords[collection];
    if (collectionRecords) {
      result.push(...collectionRecords);
    }
  }
  return result;
}

// ── Slug resolution (public) ─────────────────────────────────────

/**
 * Resolve a YAML filename slug (e.g. "anthropic") to a KB entity ID.
 * Returns undefined if the slug is not in the mapping.
 */
export function resolveKBSlug(slug: string): string | undefined {
  const kb = getKB();
  if (!kb?.slugToEntityId) return undefined;
  return kb.slugToEntityId[slug];
}

/**
 * Get the full slug→entityId mapping.
 * Useful for building static params or reverse lookups.
 */
export function getKBSlugMap(): Record<string, string> {
  const kb = getKB();
  return kb?.slugToEntityId ?? {};
}

/** Lazy-initialized inverted index: entityId → slug. Built once on first call. */
let entityIdToSlugIndex: Map<string, string> | undefined;

/**
 * Reverse lookup: find the YAML slug for a given entity ID.
 * Uses a lazy-built inverted index for O(1) lookups.
 */
export function getKBEntitySlug(entityId: string): string | undefined {
  if (!entityIdToSlugIndex) {
    const map = getKBSlugMap();
    entityIdToSlugIndex = new Map();
    for (const [slug, id] of Object.entries(map)) {
      entityIdToSlugIndex.set(id, slug);
    }
  }
  return entityIdToSlugIndex.get(entityId);
}
