/**
 * YAML → Graph loader.
 * Reads properties.yaml, schemas/*.yaml, and things/*.yaml from a data directory.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { Graph } from "./graph";
import type {
  PropertiesFile,
  SchemaFile,
  ThingFile,
  RawFact,
  Property,
  TypeSchema,
  Thing,
  Fact,
  FactValue,
  ItemCollection,
} from "./types";

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
    items: file.items,
  };
}

function parseThing(raw: ThingFile["thing"]): Thing {
  return {
    id: raw.id,
    stableId: raw.stableId,
    type: raw.type,
    name: raw.name,
    ...(raw.parent !== undefined && { parent: raw.parent }),
    ...(raw.aliases !== undefined && { aliases: raw.aliases }),
    ...(raw.previousIds !== undefined && { previousIds: raw.previousIds }),
    ...(raw.numericId !== undefined && { numericId: raw.numericId }),
  };
}

function parseFact(
  rawFact: RawFact,
  thingId: string,
  properties: Map<string, Property>
): Fact | null {
  const prop = properties.get(rawFact.property);

  // Computed properties are populated by inverse computation, not stored directly.
  if (prop?.computed) {
    console.warn(
      `[kb/loader] Skipping fact "${rawFact.id}" on "${thingId}": ` +
        `property "${rawFact.property}" is computed (populated by inverse computation).`
    );
    return null;
  }

  const value = normalizeValue(rawFact.value, prop?.dataType);

  return {
    id: rawFact.id,
    subjectId: thingId,
    propertyId: rawFact.property,
    value,
    ...(rawFact.asOf !== undefined && { asOf: String(rawFact.asOf) }),
    ...(rawFact.validEnd !== undefined && { validEnd: String(rawFact.validEnd) }),
    ...(rawFact.source !== undefined && { source: rawFact.source }),
    ...(rawFact.sourceQuote !== undefined && {
      sourceQuote: rawFact.sourceQuote,
    }),
    ...(rawFact.notes !== undefined && { notes: rawFact.notes }),
  };
}

function parseItemCollection(
  raw: ThingFile["items"],
  collectionName: string
): ItemCollection | undefined {
  if (!raw) return undefined;
  const col = raw[collectionName];
  if (!col) return undefined;
  return {
    type: col.type,
    entries: col.entries ?? {},
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
      return { name: filename, parsed: parseYaml(content) };
    })
  );

  return results;
}

// ── Main loader ────────────────────────────────────────────────────────

/**
 * Loads a knowledge base from a data directory into an in-memory Graph.
 *
 * Expected directory layout:
 *   <dataDir>/properties.yaml
 *   <dataDir>/schemas/*.yaml
 *   <dataDir>/things/*.yaml
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

  // 3. Load things
  const thingFiles = await readYamlFiles(join(dataDir, "things"));
  for (const { parsed } of thingFiles) {
    const file = parsed as ThingFile;

    // 3a. Parse thing
    const thing = parseThing(file.thing);
    graph.addThing(thing);

    // 3b. Parse facts
    for (const rawFact of file.facts ?? []) {
      const fact = parseFact(rawFact, thing.id, properties);
      if (fact) graph.addFact(fact);
    }

    // 3c. Parse items
    if (file.items) {
      for (const collectionName of Object.keys(file.items)) {
        const collection = parseItemCollection(file.items, collectionName);
        if (collection) {
          graph.addItemCollection(thing.id, collectionName, collection);
        }
      }
    }
  }

  return graph;
}
