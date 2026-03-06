/**
 * KB data access layer.
 *
 * Reads the `kb` field from database.json (populated by build-data.mjs).
 * The KB data may not exist if build-data hasn't been wired up yet,
 * so all accessors return undefined/empty gracefully.
 */

import { getDatabase } from "@data";
import type { Fact, Property, Thing, TypeSchema, ItemEntry } from "@longterm-wiki/kb";
import type { SerializedKB } from "@longterm-wiki/kb";

function getKB(): SerializedKB | undefined {
  try {
    const db = getDatabase();
    // The kb field is added by build-data.mjs but not yet in DatabaseShape.
    // Use a type assertion to access it.
    return (db as unknown as Record<string, unknown>).kb as SerializedKB | undefined;
  } catch {
    return undefined;
  }
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

  return filtered.slice().sort((a, b) => {
    if (a.asOf === undefined && b.asOf === undefined) return 0;
    if (a.asOf === undefined) return 1;
    if (b.asOf === undefined) return -1;
    return b.asOf.localeCompare(a.asOf);
  });
}

/**
 * Get the latest (most recent by asOf) fact for an entity + property.
 */
export function getKBLatest(entity: string, property: string): Fact | undefined {
  const facts = getKBFacts(entity, property);
  return facts[0]; // Already sorted most-recent-first
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
 * Get a property definition by ID.
 */
export function getKBProperty(propertyId: string): Property | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  return kb.properties.find((p) => p.id === propertyId);
}

/**
 * Get a thing definition by ID.
 */
export function getKBThing(thingId: string): Thing | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  return kb.things.find((t) => t.id === thingId);
}

/**
 * Get a type schema by type name.
 */
export function getKBSchema(type: string): TypeSchema | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  return kb.schemas.find((s) => s.type === type);
}
