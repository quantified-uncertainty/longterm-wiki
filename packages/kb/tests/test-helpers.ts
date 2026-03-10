/**
 * Shared test helpers for the KB package.
 */

import path from "node:path";
import { loadKB } from "../src/loader";
import { computeInverses } from "../src/inverse";
import type { Graph } from "../src/graph";

export const DATA_DIR = path.resolve(__dirname, "../data");

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
  const result = await loadKB(DATA_DIR);
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
