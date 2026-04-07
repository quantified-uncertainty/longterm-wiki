export interface ThingRow {
  id: string;
  thingType: string;
  title: string;
  parentThingId: string | null;
  sourceTable: string;
  sourceId: string;
  entityType: string | null;
  description: string | null;
  href: string | null;
  parentTitle: string | null;
  updatedAt: string | null;
}

export interface ThingsStatsResponse {
  total: number;
  byType: Record<string, number>;
  byEntityType: Record<string, number>;
}

/** Format a thingType value as a readable label (e.g. "funding-program" → "Funding Program"). */
export function formatType(type: string): string {
  return type.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
