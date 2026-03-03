import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityById } from "@data";

// ---- Types ----

export interface StatementRow {
  id: number;
  variety: string;
  statementText: string | null;
  status: string;
  subjectEntityId: string;
  propertyId: string | null;
  qualifierKey: string | null;
  valueNumeric: number | null;
  valueUnit: string | null;
  valueText: string | null;
  valueEntityId: string | null;
  valueDate: string | null;
  valueSeries: Record<string, unknown> | null;
  validStart: string | null;
  validEnd: string | null;
  temporalGranularity: string | null;
  attributedTo: string | null;
  verdict: string | null;
  verdictScore: number | null;
  verdictQuotes: string | null;
  verdictModel: string | null;
  verifiedAt: string | null;
  claimCategory: string | null;
  sourceFactKey: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string | null;
  citationCount: number;
}

export interface PropertyRow {
  id: string;
  label: string;
  category: string;
  description: string | null;
  valueType: string;
  unitFormatId: string | null;
  statementCount: number;
  entityTypes?: string[];
  defaultUnit?: string | null;
  stalenessCadence?: string | null;
}

// ---- Fetchers ----

/**
 * Fetch all statements from wiki-server, paginated.
 */
export async function fetchAllStatements(): Promise<StatementRow[]> {
  const result = await fetchFromWikiServer<{
    statements: StatementRow[];
    total: number;
  }>("/api/statements?limit=500", { revalidate: 300 });

  if (!result) return [];
  return result.statements;
}

/**
 * Fetch all properties from wiki-server.
 */
export async function fetchAllProperties(): Promise<PropertyRow[]> {
  const result = await fetchFromWikiServer<{
    properties: PropertyRow[];
  }>("/api/statements/properties", { revalidate: 300 });

  if (!result) return [];
  return result.properties;
}

/**
 * Build a map of entity slugs to display names.
 */
export function buildEntityNameMap(
  entityIds: string[]
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const id of entityIds) {
    const entity = getEntityById(id);
    if (entity) {
      map[id] = entity.title;
    }
  }
  return map;
}
