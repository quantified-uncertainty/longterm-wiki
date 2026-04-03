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

const localDataDir = path.resolve(process.cwd(), "src/data");

interface ResourceFactLinksData {
  resourceUrlToFactIds: Record<string, string[]>;
  factIdToResourceId: Record<string, string>;
}

let _data: ResourceFactLinksData | undefined | null = null; // null = not yet loaded

function loadData(): ResourceFactLinksData | undefined {
  if (_data !== null) return _data;

  const filePath = path.join(localDataDir, "resource-fact-links.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).resourceUrlToFactIds !==
        "object" ||
      (parsed as Record<string, unknown>).resourceUrlToFactIds === null ||
      typeof (parsed as Record<string, unknown>).factIdToResourceId !==
        "object" ||
      (parsed as Record<string, unknown>).factIdToResourceId === null
    ) {
      console.error(
        `resource-fact-links.json has unexpected shape — expected {resourceUrlToFactIds: object, factIdToResourceId: object}`,
      );
      _data = undefined;
      return _data;
    }

    _data = parsed as ResourceFactLinksData;
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
