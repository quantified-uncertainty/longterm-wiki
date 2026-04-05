/**
 * Entity-type-aware coverage scoring.
 *
 * Each entity type has a scoring function that examines the available data
 * and returns a 1-4 score reflecting content depth. The scoring considers
 * structured data fields, relationship counts, and wiki page presence.
 *
 * Score semantics:
 *   1 = Stub — minimal data, just a name and type
 *   2 = Basic — a few key fields populated
 *   3 = Moderate — substantial data across multiple dimensions
 *   4 = Comprehensive — rich data with relationships and content
 */

// ── Organization scoring ────────────────────────────────────────────

export interface OrgCoverageInput {
  revenueNum?: number | null;
  valuationNum?: number | null;
  headcount?: number | null;
  totalFundingNum?: number | null;
  foundedDate?: string | null;
  peopleCount?: number | null;
  wikiPageId?: string | null;
}

export function computeOrgCoverage(row: OrgCoverageInput): number {
  let signals = 0;

  // Financial metrics (0-4 signals)
  if (row.revenueNum != null) signals++;
  if (row.valuationNum != null) signals++;
  if (row.headcount != null) signals++;
  if (row.totalFundingNum != null) signals++;

  // Basic metadata
  if (row.foundedDate) signals++;

  // Relationships
  if (row.peopleCount != null && row.peopleCount >= 3) signals++;
  if (row.peopleCount != null && row.peopleCount >= 10) signals++;

  // Wiki page
  if (row.wikiPageId) signals++;

  // Map signal count to 1-4 score
  if (signals >= 6) return 4;
  if (signals >= 4) return 3;
  if (signals >= 2) return 2;
  return 1;
}

// ── Person scoring ──────────────────────────────────────────────────

export interface PersonCoverageInput {
  role?: string | null;
  employerId?: string | null;
  bornYear?: number | null;
  netWorthNum?: number | null;
  positionCount?: number;
  publicationCount?: number;
  careerHistoryCount?: number;
  wikiPageId?: string | null;
}

export function computePersonCoverage(row: PersonCoverageInput): number {
  let signals = 0;

  if (row.role) signals++;
  if (row.employerId) signals++;
  if (row.bornYear != null) signals++;
  if (row.netWorthNum != null) signals++;
  if ((row.careerHistoryCount ?? 0) >= 2) signals++;
  if ((row.careerHistoryCount ?? 0) >= 5) signals++;
  if ((row.publicationCount ?? 0) >= 1) signals++;
  if (row.wikiPageId) signals++;

  if (signals >= 6) return 4;
  if (signals >= 4) return 3;
  if (signals >= 2) return 2;
  return 1;
}

// ── AI Model scoring ────────────────────────────────────────────────

export interface AiModelCoverageInput {
  developer?: string | null;
  releaseDate?: string | null;
  inputPrice?: number | null;
  outputPrice?: number | null;
  contextWindow?: number | null;
  parameterCount?: string | null;
  safetyLevel?: string | null;
  benchmarkCount?: number; // number of benchmark scores available
  wikiId?: string | null;
}

export function computeAiModelCoverage(row: AiModelCoverageInput): number {
  let signals = 0;

  if (row.developer) signals++;
  if (row.releaseDate) signals++;
  if (row.inputPrice != null) signals++;
  if (row.contextWindow != null) signals++;
  if (row.parameterCount) signals++;
  if (row.safetyLevel) signals++;
  if ((row.benchmarkCount ?? 0) >= 1) signals++;
  if ((row.benchmarkCount ?? 0) >= 3) signals++;
  if (row.wikiId) signals++;

  if (signals >= 7) return 4;
  if (signals >= 5) return 3;
  if (signals >= 3) return 2;
  return 1;
}

// ── Legislation scoring ─────────────────────────────────────────────

export interface LegislationCoverageInput {
  introduced?: string | null;
  policyStatus?: string | null;
  author?: string | null;
  jurisdiction?: string | null;
  billNumber?: string | null;
  fullTextUrl?: string | null;
  description?: string | null;
  tags?: string[];
  wikiId?: string | null;
}

export function computeLegislationCoverage(row: LegislationCoverageInput): number {
  let signals = 0;

  if (row.introduced) signals++;
  if (row.policyStatus) signals++;
  if (row.author) signals++;
  if (row.jurisdiction) signals++;
  if (row.billNumber) signals++;
  if (row.fullTextUrl) signals++;
  if (row.description) signals++;
  if ((row.tags?.length ?? 0) >= 1) signals++;
  if (row.wikiId) signals++;

  if (signals >= 7) return 4;
  if (signals >= 5) return 3;
  if (signals >= 3) return 2;
  return 1;
}

// ── Generic scoring (for entity types without specialized scorers) ──

export interface GenericCoverageInput {
  description?: string | null;
  tags?: string[];
  wikiId?: string | null;
  /** Count of filled optional fields beyond name/type */
  filledFieldCount?: number;
}

export function computeGenericCoverage(row: GenericCoverageInput): number {
  let signals = 0;

  if (row.description) signals++;
  if ((row.tags?.length ?? 0) >= 1) signals++;
  if (row.wikiId) signals++;
  signals += Math.min(row.filledFieldCount ?? 0, 4);

  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
  return 1;
}
