/**
 * Shared types for the Statements system.
 *
 * These types match the wiki-server `/api/statements/by-entity` response shape.
 * Used by EntityStatementsCard, PageStatementsSection, and the statements page.
 */

export interface Citation {
  id: number;
  resourceId: string | null;
  url: string | null;
  sourceQuote: string | null;
  locationNote: string | null;
  isPrimary: boolean;
}

export interface PropertyInfo {
  id: string;
  label: string;
  category: string;
  valueType: string;
  unitFormatId: string | null;
}

export interface StatementWithDetails {
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
  attributedTo: string | null;
  sourceFactKey: string | null;
  note: string | null;
  verdict: string | null;
  verdictScore: number | null;
  verdictQuotes: string | null;
  verdictModel: string | null;
  verifiedAt: string | null;
  claimCategory: string | null;
  property: PropertyInfo | null;
  citations: Citation[];
}

export interface ByEntityResult {
  structured: StatementWithDetails[];
  attributed: StatementWithDetails[];
  total: number;
}
