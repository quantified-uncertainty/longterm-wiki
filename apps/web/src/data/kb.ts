/**
 * KB data access layer.
 *
 * Reads the `kb` field from database.json (populated by build-data.mjs).
 * The KB data may not exist if build-data hasn't been wired up yet,
 * so all accessors return undefined/empty gracefully.
 */

import { getDatabase } from "@data";
import type { Fact, Property, Entity, TypeSchema, ItemEntry } from "@longterm-wiki/kb";
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
 * Get a type schema by type name.
 */
export function getKBSchema(type: string): TypeSchema | undefined {
  const kb = getKB();
  if (!kb) return undefined;

  return kb.schemas.find((s) => s.type === type);
}

/**
 * Find all item entries across all entities that reference the given thingId.
 * Scans item fields for string matches against the thingId.
 * Uses schema field definitions when available to identify ref-type fields.
 */
export function getKBItemsMentioning(
  thingId: string
): Array<{
  ownerThingId: string;
  ownerName: string;
  collection: string;
  entry: ItemEntry;
  matchingFields: string[];
}> {
  const kb = getKB();
  if (!kb) return [];

  const results: Array<{
    ownerThingId: string;
    ownerName: string;
    collection: string;
    entry: ItemEntry;
    matchingFields: string[];
  }> = [];

  for (const [ownerThingId, collections] of Object.entries(kb.items)) {
    if (ownerThingId === thingId) continue; // Skip self

    const ownerThing = kb.entities.find((t: Entity) => t.id === ownerThingId);
    const schema = ownerThing
      ? kb.schemas.find((s) => s.type === ownerThing.type)
      : undefined;

    for (const [collectionName, entries] of Object.entries(collections)) {
      const fieldDefs = schema?.items?.[collectionName]?.fields;

      for (const entry of entries) {
        const matchingFields: string[] = [];

        for (const [fieldName, fieldValue] of Object.entries(entry.fields)) {
          const fieldDef = fieldDefs?.[fieldName];

          if (fieldDef?.type === "ref" && fieldValue === thingId) {
            matchingFields.push(fieldName);
          } else if (
            !fieldDef &&
            typeof fieldValue === "string" &&
            fieldValue === thingId
          ) {
            matchingFields.push(fieldName);
          }
        }

        if (matchingFields.length > 0) {
          results.push({
            ownerThingId,
            ownerName: ownerThing?.name ?? ownerThingId,
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
