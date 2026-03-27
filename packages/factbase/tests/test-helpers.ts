/**
 * Shared test helpers for the KB package.
 */

import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { loadKB } from "../src/loader";
import { computeInverses } from "../src/inverse";
import type { Graph } from "../src/graph";
import type { Entity } from "../src/types";

export const DATA_DIR = path.resolve(__dirname, "../data");
const ENTITIES_DIR = path.resolve(__dirname, "../../../data/entities");

/**
 * Build a TableBase entity map from data/entities/*.yaml, matching
 * what the production loader receives via crux/lib/factbase-loader.ts.
 * This ensures tests see the same entity metadata (name, type, aliases)
 * that the app sees at runtime.
 */
function buildEntityMap(): Map<string, Entity> {
  const entityMap = new Map<string, Entity>();
  let files: string[];
  try {
    files = readdirSync(ENTITIES_DIR).filter((f) => f.endsWith(".yaml"));
  } catch {
    return entityMap;
  }
  for (const file of files) {
    try {
      const content = readFileSync(path.join(ENTITIES_DIR, file), "utf-8");
      const data = parseYaml(content);
      if (!Array.isArray(data)) continue;
      for (const entry of data) {
        if (!entry.stableId) continue;
        entityMap.set(entry.stableId, {
          id: entry.stableId,
          stableId: entry.stableId,
          type: entry.type || "unknown",
          name: entry.title || entry.id,
          ...(entry.wikiId && { wikiPageId: entry.wikiId, wikiId: entry.wikiId }),
          ...(Array.isArray(entry.aliases) && entry.aliases.length > 0 && { aliases: entry.aliases }),
        });
      }
    } catch {
      // Skip unparseable files
    }
  }
  return entityMap;
}

/**
 * Load the real KB data and return { graph, idOf }.
 * `idOf(filename)` resolves a YAML filename (e.g., "anthropic") to its entity ID.
 *
 * @param options.withInverses - Also compute inverse facts (default: false)
 */
export async function loadTestKB(options?: {
  withInverses?: boolean;
}): Promise<{
  graph: Graph;
  idOf: (filename: string) => string;
}> {
  const entities = buildEntityMap();
  const result = await loadKB(DATA_DIR, { entities });
  if (options?.withInverses) {
    computeInverses(result.graph);
  }
  const reverseMap = new Map<string, string>();
  for (const [entityId, filename] of result.filenameMap) {
    reverseMap.set(filename, entityId);
  }
  const idOf = (filename: string): string => {
    const id = reverseMap.get(filename);
    if (!id) throw new Error(`No entity for filename "${filename}"`);
    return id;
  };
  return { graph: result.graph, idOf };
}
