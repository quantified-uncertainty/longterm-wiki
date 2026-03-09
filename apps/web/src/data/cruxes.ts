/**
 * Crux data lookups.
 */

import { getDatabase } from "./database";
import type { CruxData } from "./database";

let _cruxIndex: Map<string, CruxData> | null = null;

function cruxIndex(): Map<string, CruxData> {
  if (_cruxIndex) return _cruxIndex;
  const db = getDatabase();
  _cruxIndex = new Map((db.cruxes || []).map((c) => [c.id, c]));
  return _cruxIndex;
}

export function getCruxById(id: string): CruxData | undefined {
  return cruxIndex().get(id);
}

export function getCruxes(): CruxData[] {
  const db = getDatabase();
  return db.cruxes || [];
}

export function getCruxesByDomain(domain: string): CruxData[] {
  return getCruxes().filter(
    (c) => c.domain?.toLowerCase() === domain.toLowerCase()
  );
}
