/**
 * YAML → Graph loader.
 * Reads properties.yaml, schemas/*.yaml, and things/*.yaml from a data directory.
 *
 * Supports !ref YAML tags for stable references between entities:
 *   value: !ref mK9pX3rQ7n:dario-amodei   → resolves stableId, cross-validates slug
 *   value: !ref mK9pX3rQ7n                 → bare stableId (deprecated, still works)
 *
 * Supports !date YAML tags for explicit date typing:
 *   founded: !date 2019        → { type: "date", value: "2019" }
 *   started: !date 2023-06     → { type: "date", value: "2023-06" }
 *   born:    !date 2023-06-15  → { type: "date", value: "2023-06-15" }
 * Useful for bare years (2019) which would otherwise be parsed as numbers.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Scalar, ScalarTag } from "yaml";
import { Graph } from "./graph";
import type {
  PropertiesFile,
  SchemaFile,
  RecordSchemaFile,
  EntityFile,
  RawFact,
  Property,
  TypeSchema,
  Entity,
  Fact,
  FactValue,
  RecordSchema,
  RecordEntry,
  EndpointDef,
} from "./types";

// ── !ref YAML tag ──────────────────────────────────────────────────

/**
 * Marker class for !ref YAML tags. Created during YAML parsing,
 * resolved to entity IDs after all things are loaded.
 *
 * Format: !ref <entityId>:<slug>  (preferred — enables cross-validation)
 *         !ref <entityId>         (bare — still works)
 */
export class RefMarker {
  constructor(
    /** The entity ID (10-char stable ID) from the !ref tag */
    public readonly stableId: string,
    /** Optional slug for cross-validation */
    public readonly expectedSlug?: string,
  ) {}
}

/** Custom YAML tag: !ref <stableId> or !ref <stableId>:<slug> */
const refTag: ScalarTag = {
  tag: "!ref",
  resolve(str: string): RefMarker {
    const colonIdx = str.indexOf(":");
    if (colonIdx > 0) {
      const stableId = str.slice(0, colonIdx);
      const slug = str.slice(colonIdx + 1);
      return new RefMarker(stableId, slug);
    }
    return new RefMarker(str);
  },
  identify(value: unknown): value is RefMarker {
    return value instanceof RefMarker;
  },
  stringify(item: Scalar): string {
    const marker = item.value as RefMarker;
    if (marker.expectedSlug) {
      return `!ref ${marker.stableId}:${marker.expectedSlug}`;
    }
    return `!ref ${marker.stableId}`;
  },
};

// ── !date YAML tag ──────────────────────────────────────────────────

/**
 * Marker class for !date YAML tags. Created during YAML parsing,
 * converted to { type: "date", value: string } by normalizeValue.
 *
 * Accepts any scalar — bare years (2019), year-month (2023-06), or
 * full ISO dates (2023-06-15). The raw value is stored as a string.
 */
export class DateMarker {
  constructor(public readonly value: string) {}
}

/** Custom YAML tag: !date <value> */
const dateTag: ScalarTag = {
  tag: "!date",
  resolve(str: string): DateMarker {
    return new DateMarker(str);
  },
  identify(value: unknown): value is DateMarker {
    return value instanceof DateMarker;
  },
  stringify(item: Scalar): string {
    const marker = item.value as DateMarker;
    return `!date ${marker.value}`;
  },
};

const CUSTOM_TAGS = [refTag, dateTag];

/**
 * Recursively resolves RefMarker instances in a parsed YAML structure.
 * Returns the value with all RefMarkers replaced by their slug strings.
 */
function resolveRefs(
  value: unknown,
  graph: Graph,
  context: string
): unknown {
  // DateMarker in facts: pass through as-is so normalizeValue() can handle it.
  // DateMarker in records: convert to the plain date string.
  if (value instanceof DateMarker) {
    return context.endsWith("/facts") ? value : value.value;
  }

  if (value instanceof RefMarker) {
    const entity = graph.getEntity(value.stableId);
    if (!entity) {
      console.warn(
        `[kb/loader] Unresolved !ref "${value.stableId}" in ${context}`
      );
      return value.stableId; // fallback: use raw ID
    }
    // Cross-validate: if expectedSlug was provided, verify it matches
    if (value.expectedSlug && value.expectedSlug !== entity.slug) {
      throw new Error(
        `[kb/loader] !ref mismatch in ${context}: id "${value.stableId}" ` +
          `resolves to slug "${entity.slug}" but expected "${value.expectedSlug}". ` +
          `Either the id or the slug is wrong.`
      );
    }
    return entity.id; // return the entity ID (stable 10-char)
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolveRefs(v, graph, context));
  }

  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      resolved[k] = resolveRefs(v, graph, context);
    }
    return resolved;
  }

  return value;
}

// ── Value normalization ────────────────────────────────────────────────

/**
 * ISO date pattern: full date (2021-01-01) or year-month (2021-01).
 * Does NOT match bare years like "2021" to avoid false positives with numbers.
 */
const DATE_RE = /^\d{4}-\d{2}(-\d{2})?$/;

/**
 * Normalizes a raw YAML value into a typed FactValue.
 * The property's dataType is used as a hint — if the property says "ref",
 * a string value is wrapped as {type: "ref"} rather than {type: "text"}.
 */
function normalizeValue(raw: unknown, dataType?: string): FactValue {
  // !date YAML tag — explicit date typing, takes priority over everything.
  if (raw instanceof DateMarker) {
    return { type: "date", value: raw.value };
  }

  // Range/min detection — structural patterns that take priority over dataType.
  // A two-element numeric array is always a range, and an object with { min: N }
  // is always a min bound, regardless of what the property's dataType says.
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    typeof raw[0] === "number" &&
    typeof raw[1] === "number"
  ) {
    return { type: "range", low: raw[0], high: raw[1] };
  }
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    !(raw instanceof DateMarker) &&
    "min" in raw &&
    typeof (raw as Record<string, unknown>).min === "number"
  ) {
    return { type: "min", value: (raw as Record<string, unknown>).min as number };
  }

  // When an explicit dataType is declared, it is authoritative.
  if (dataType) {
    switch (dataType) {
      case "ref":
        return { type: "ref", value: String(raw) };
      case "refs":
        if (Array.isArray(raw)) {
          return { type: "refs", value: raw.map(String) };
        }
        return { type: "refs", value: [String(raw)] };
      case "number":
        return { type: "number", value: Number(raw) };
      case "text":
        return { type: "text", value: String(raw) };
      case "date":
        return { type: "date", value: String(raw) };
      case "boolean":
        return { type: "boolean", value: Boolean(raw) };
      // dataType declared but not one of the simple types — fall through
    }
  }

  // Heuristic detection when no dataType is declared
  if (typeof raw === "boolean") {
    return { type: "boolean", value: raw };
  }

  if (typeof raw === "number") {
    return { type: "number", value: raw };
  }

  if (typeof raw === "string") {
    if (DATE_RE.test(raw)) {
      return { type: "date", value: raw };
    }
    return { type: "text", value: raw };
  }

  if (Array.isArray(raw)) {
    if (raw.every((v) => typeof v === "string")) {
      return { type: "refs", value: raw as string[] };
    }
    return { type: "json", value: raw };
  }

  return { type: "json", value: raw };
}

// ── Individual parsers ─────────────────────────────────────────────────

function parseProperties(raw: unknown): Map<string, Property> {
  const file = raw as PropertiesFile;
  const result = new Map<string, Property>();

  for (const [id, def] of Object.entries(file.properties ?? {})) {
    result.set(id, { id, ...def });
  }

  return result;
}

function parseSchema(raw: unknown): TypeSchema {
  const file = raw as SchemaFile;
  return {
    type: file.type,
    name: file.name,
    required: file.required ?? [],
    recommended: file.recommended ?? [],
    ...(file.records && { records: file.records }),
  };
}

function parseRecordSchema(id: string, raw: unknown): RecordSchema {
  const file = raw as RecordSchemaFile;
  const endpoints: Record<string, EndpointDef> = {};
  for (const [name, def] of Object.entries(file.endpoints ?? {})) {
    endpoints[name] = {
      types: def.types,
      ...(def.implicit && { implicit: true }),
      ...(def.required && { required: true }),
      ...(def.allow_display_name && { allowDisplayName: true }),
    };
  }
  return {
    id,
    name: file.name,
    ...(file.description && { description: file.description }),
    endpoints,
    fields: file.fields ?? {},
    ...(file.temporal && { temporal: true }),
  };
}

/** Coerce wiki page ID to a string with E prefix (YAML may parse bare numbers like 1100). */
function normalizeWikiPageId(raw: string | number): string {
  const s = String(raw);
  return s.startsWith("E") ? s : `E${s}`;
}

/**
 * Parse a YAML entity thing block into an Entity, handling both old and new formats.
 *
 * Old format: { id: "anthropic", stableId: "mK9pX3rQ7n", numericId: "E22" }
 * New format: { id: "mK9pX3rQ7n", slug: "anthropic", wikiPageId: "E22" }
 *
 * Detection: if `stableId` is present, it's old format.
 */
function parseEntity(raw: EntityFile["thing"]): Entity {
  const isOldFormat = raw.stableId !== undefined;

  if (isOldFormat) {
    // Old format: id is slug, stableId is the stable ID
    const wikiPageId = raw.numericId !== undefined
      ? normalizeWikiPageId(raw.numericId)
      : undefined;
    return {
      id: raw.stableId!,
      slug: raw.id,
      type: raw.type,
      name: raw.name,
      ...(raw.parent !== undefined && { parent: raw.parent }),
      ...(raw.aliases !== undefined && { aliases: raw.aliases }),
      ...(raw.previousIds !== undefined && { previousIds: raw.previousIds }),
      ...(wikiPageId !== undefined && { wikiPageId }),
      // Deprecated aliases for backward compat
      stableId: raw.stableId!,
      ...(wikiPageId !== undefined && { numericId: wikiPageId }),
    };
  }

  // New format: id is the stable ID, slug is the slug
  const wikiPageId = raw.wikiPageId !== undefined
    ? normalizeWikiPageId(raw.wikiPageId)
    : raw.numericId !== undefined
      ? normalizeWikiPageId(raw.numericId)
      : undefined;
  if (!raw.slug) {
    throw new Error(
      `[kb/loader] Entity "${raw.id}" is in new format but missing required "slug" field`
    );
  }
  return {
    id: raw.id,
    slug: raw.slug,
    type: raw.type,
    name: raw.name,
    ...(raw.parent !== undefined && { parent: raw.parent }),
    ...(raw.aliases !== undefined && { aliases: raw.aliases }),
    ...(raw.previousIds !== undefined && { previousIds: raw.previousIds }),
    ...(wikiPageId !== undefined && { wikiPageId }),
    // Deprecated aliases
    stableId: raw.id,
    ...(wikiPageId !== undefined && { numericId: wikiPageId }),
  };
}

function parseFact(
  rawFact: RawFact,
  entityId: string,
  properties: Map<string, Property>
): Fact | null {
  const prop = properties.get(rawFact.property);

  // Computed properties are populated by inverse computation, not stored directly.
  if (prop?.computed) {
    console.warn(
      `[kb/loader] Skipping fact "${rawFact.id}" on "${entityId}": ` +
        `property "${rawFact.property}" is computed (populated by inverse computation).`
    );
    return null;
  }

  const value = normalizeValue(rawFact.value, prop?.dataType);

  // asOf/validEnd may be DateMarker objects from !date YAML tags
  const asOfRaw: unknown = rawFact.asOf;
  const validEndRaw: unknown = rawFact.validEnd;
  const asOf = asOfRaw instanceof DateMarker ? asOfRaw.value : asOfRaw !== undefined ? String(asOfRaw) : undefined;
  const validEnd = validEndRaw instanceof DateMarker ? validEndRaw.value : validEndRaw !== undefined ? String(validEndRaw) : undefined;

  return {
    id: rawFact.id,
    subjectId: entityId,
    propertyId: rawFact.property,
    value,
    ...(asOf !== undefined && { asOf }),
    ...(validEnd !== undefined && { validEnd }),
    ...(rawFact.source !== undefined && { source: rawFact.source }),
    ...(rawFact.sourceQuote !== undefined && {
      sourceQuote: rawFact.sourceQuote,
    }),
    ...(rawFact.notes !== undefined && { notes: rawFact.notes }),
    ...(rawFact.currency !== undefined && { currency: rawFact.currency }),
    ...(rawFact.usdEquivalent !== undefined && { usdEquivalent: Number(rawFact.usdEquivalent) }),
    ...(rawFact.exchangeRate !== undefined && { exchangeRate: Number(rawFact.exchangeRate) }),
    ...(rawFact.exchangeRateDate !== undefined && { exchangeRateDate: rawFact.exchangeRateDate }),
    ...(rawFact.dollarYear !== undefined && { dollarYear: Number(rawFact.dollarYear) }),
  };
}

// ── Helper: read all .yaml files from a directory ─────────────────────

async function readYamlFiles(dir: string): Promise<{ name: string; parsed: unknown }[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []; // Directory doesn't exist — optional
    }
    throw error; // Permission errors, broken paths, etc. should surface
  }

  const yamlFiles = entries.filter(
    (e) => extname(e) === ".yaml" || extname(e) === ".yml"
  );

  const results = await Promise.all(
    yamlFiles.map(async (filename) => {
      const content = await readFile(join(dir, filename), "utf-8");
      return { name: filename, parsed: parseYaml(content, { customTags: CUSTOM_TAGS }) };
    })
  );

  return results;
}

// ── Record helpers ─────────────────────────────────────────────────────

/**
 * Maps a collection name (e.g., "funding-rounds") to a record schema ID
 * (e.g., "funding-round"). Tries exact match, then depluralization.
 */
function findRecordSchemaId(
  collectionName: string,
  allowedIds: string[],
  graph: Graph,
): string | undefined {
  // Exact match (e.g., collection "career-history" → schema "career-history")
  if (allowedIds.includes(collectionName) && graph.getRecordSchema(collectionName)) {
    return collectionName;
  }

  // Depluralize and check: "funding-rounds" → "funding-round",
  // "career-histories" → "career-history"
  const candidates: string[] = [];
  if (collectionName.endsWith("ies")) {
    candidates.push(collectionName.slice(0, -3) + "y"); // histories → history
  }
  if (collectionName.endsWith("s")) {
    candidates.push(collectionName.slice(0, -1)); // rounds → round
  }
  for (const singular of candidates) {
    if (allowedIds.includes(singular) && graph.getRecordSchema(singular)) {
      return singular;
    }
  }

  // Check all allowed IDs for plural match: schema "grant" → collection "grants"
  for (const id of allowedIds) {
    if (id + "s" === collectionName && graph.getRecordSchema(id)) {
      return id;
    }
  }
  return undefined;
}

/**
 * Parses a raw YAML record entry into a RecordEntry.
 * Separates temporal fields (asOf, validEnd), display_name, and data fields.
 * Warns if required explicit endpoints are missing.
 */
function parseRecordEntry(
  key: string,
  raw: Record<string, unknown>,
  schemaId: string,
  ownerEntityId: string,
  schema: RecordSchema,
): RecordEntry {
  const fields: Record<string, unknown> = {};
  let displayName: string | undefined;
  let asOf: string | undefined;
  let validEnd: string | undefined;

  // resolveRefs() already converts DateMarker to plain strings for non-facts
  // contexts, so asOf/validEnd arrive as strings here.
  for (const [fieldName, fieldValue] of Object.entries(raw)) {
    if (fieldName === "display_name") {
      displayName = String(fieldValue);
    } else if (fieldName === "asOf") {
      asOf = String(fieldValue);
    } else if (fieldName === "validEnd") {
      validEnd = String(fieldValue);
    } else {
      fields[fieldName] = fieldValue;
    }
  }

  // Warn about missing required explicit endpoints
  for (const [endpointName, endpointDef] of Object.entries(schema.endpoints)) {
    if (endpointDef.implicit) continue;
    if (endpointDef.required && !fields[endpointName] && !displayName) {
      console.warn(
        `[kb/loader] Record "${ownerEntityId}/${schemaId}/${key}" is missing ` +
        `required endpoint "${endpointName}" (and no display_name fallback)`
      );
    }
  }

  return {
    key,
    schema: schemaId,
    ownerEntityId,
    fields,
    ...(displayName && { displayName }),
    ...(asOf && { asOf }),
    ...(validEnd && { validEnd }),
  };
}

// ── Main loader ────────────────────────────────────────────────────────

/**
 * Loads a knowledge base from a data directory into an in-memory Graph.
 *
 * Expected directory layout:
 *   <dataDir>/properties.yaml
 *   <dataDir>/schemas/*.yaml
 *   <dataDir>/things/*.yaml
 *
 * Uses a two-pass approach for entities:
 *   Pass 1: Load all entity headers (builds stableId → slug index)
 *   Pass 2: Load facts and items (resolves !ref tags using the index)
 */
export async function loadKB(dataDir: string): Promise<Graph> {
  const graph = new Graph();

  // 1. Load properties
  let properties = new Map<string, Property>();
  try {
    const propertiesContent = await readFile(
      join(dataDir, "properties.yaml"),
      "utf-8"
    );
    properties = parseProperties(parseYaml(propertiesContent));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error; // Malformed YAML or permission errors should surface
    }
    // properties.yaml is optional for minimal setups
  }

  for (const property of properties.values()) {
    graph.addProperty(property);
  }

  // 2. Load schemas
  const schemaFiles = await readYamlFiles(join(dataDir, "schemas"));
  for (const { parsed } of schemaFiles) {
    const schema = parseSchema(parsed);
    graph.addSchema(schema);
  }

  // 2b. Load record schemas (schemas/records/*.yaml)
  const recordSchemaFiles = await readYamlFiles(join(dataDir, "schemas", "records"));
  for (const { name, parsed } of recordSchemaFiles) {
    const id = name.replace(/\.(yaml|yml)$/, "");
    const recordSchema = parseRecordSchema(id, parsed);
    graph.addRecordSchema(recordSchema);
  }

  // 3. Load entities (two passes)
  const entityFiles = await readYamlFiles(join(dataDir, "things"));

  // Pass 1: Load all entity headers to build stableId index
  const parsedEntityFiles: { entity: Entity; file: EntityFile }[] = [];
  for (const { parsed } of entityFiles) {
    const file = parsed as EntityFile;
    const entity = parseEntity(file.thing);
    graph.addEntity(entity);
    parsedEntityFiles.push({ entity, file });
  }

  // Pass 2: Load facts and records with !ref resolution
  for (const { entity, file } of parsedEntityFiles) {
    // Resolve !ref markers in facts (use entity.slug for log context)
    for (const rawFact of file.facts ?? []) {
      const resolvedValue = resolveRefs(rawFact.value, graph, `${entity.slug}/facts`);
      const resolvedFact = { ...rawFact, value: resolvedValue };
      const fact = parseFact(resolvedFact as RawFact, entity.id, properties);
      if (fact) graph.addFact(fact);
    }

    // Parse records
    if (file.records) {
      const resolvedRecords = resolveRefs(
        file.records,
        graph,
        `${entity.slug}/records`
      ) as Record<string, Record<string, Record<string, unknown>>>;

      // Look up which record schemas this entity type can host
      const typeSchema = graph.getSchema(entity.type);
      const allowedRecordIds = typeSchema?.records ?? [];

      for (const [collectionName, rawEntries] of Object.entries(resolvedRecords)) {
        // Map collection name to schema ID. Collection names use pluralized
        // form (e.g., "funding-rounds") while schema IDs are singular
        // (e.g., "funding-round"). Try both.
        const schemaId = findRecordSchemaId(collectionName, allowedRecordIds, graph);
        if (!schemaId) {
          console.warn(
            `[kb/loader] Unknown record collection "${collectionName}" on entity "${entity.slug}" ` +
            `(allowed: ${allowedRecordIds.join(", ")})`
          );
          continue;
        }

        const recordSchema = graph.getRecordSchema(schemaId);
        if (!recordSchema) {
          console.warn(
            `[kb/loader] Record schema "${schemaId}" not found for collection "${collectionName}" on "${entity.slug}"`
          );
          continue;
        }

        for (const [key, rawEntry] of Object.entries(rawEntries)) {
          const entry = parseRecordEntry(
            key,
            rawEntry,
            schemaId,
            entity.id,
            recordSchema,
          );
          graph.addRecord(collectionName, entry);
        }
      }
    }
  }

  return graph;
}
