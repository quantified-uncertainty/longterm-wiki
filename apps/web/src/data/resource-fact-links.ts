/**
 * Resource ↔ FactBase Cross-Links
 *
 * Data access layer for the build-time index that connects FactBase facts
 * (which have `source` URLs) with tracked Resources (which have URLs).
 *
 * Reads resource-fact-links.json (populated by build-data.mjs), which contains:
 *   - resourceUrlToFactIds: resourceId → factId[] (for resource detail pages)
 *   - factIdToResourceId: factId → resourceId (for fact detail pages)
 *
 * Like other data files, this is loaded once at build/server time and cached.
 */

import fs from "fs";
import path from "path";

const LOCAL_DATA_DIR = path.resolve(process.cwd(), "src/data");

interface ResourceFactLinksData {
  resourceUrlToFactIds: Record<string, string[]>;
  factIdToResourceId: Record<string, string>;
}

let _data: ResourceFactLinksData | undefined | null = null; // null = not yet loaded

function loadData(): ResourceFactLinksData | undefined {
  if (_data !== null) return _data;

  const filePath = path.join(LOCAL_DATA_DIR, "resource-fact-links.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    _data = JSON.parse(raw) as ResourceFactLinksData;
  } catch {
    _data = undefined;
  }
  return _data;
}

/**
 * Get all FactBase fact IDs that cite a given resource.
 * Looks up by resource ID (the hash ID used in /resources/[id] routes).
 * Returns an empty array if no facts cite this resource.
 */
export function getFactIdsForResource(resourceId: string): string[] {
  const data = loadData();
  if (!data) return [];
  return data.resourceUrlToFactIds[resourceId] ?? [];
}

/**
 * Get the resource ID for a fact if its source URL matches a tracked resource.
 * Returns null if the fact's source doesn't match any resource.
 */
export function getResourceIdForFact(factId: string): string | null {
  const data = loadData();
  if (!data) return null;
  return data.factIdToResourceId[factId] ?? null;
}
