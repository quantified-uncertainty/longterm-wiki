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
  if ((row.positionCount ?? 0) >= 1) signals++;
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
  if (row.inputPrice != null || row.outputPrice != null) signals++;
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
  signals += Math.min(row.filledFieldCount ?? 0, 2);

  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
  return 1;
}

// ── Project scoring ─────────────────────────────────────────────────

export interface ProjectCoverageInput {
  description?: string | null;
  status?: string | null;
  website?: string | null;
  orgName?: string | null;
  clusters?: string[];
  wikiId?: string | null;
}

export function computeProjectCoverage(row: ProjectCoverageInput): number {
  let signals = 0;

  if (row.description) signals++;
  if (row.status) signals++;
  if (row.website) signals++;
  if (row.orgName) signals++;
  if ((row.clusters?.length ?? 0) >= 1) signals++;
  if (row.wikiId) signals++;

  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
  return 1;
}

// ── Benchmark scoring ───────────────────────────────────────────────

export interface BenchmarkCoverageInput {
  category?: string | null;
  scoringMethod?: string | null;
  introducedDate?: string | null;
  maintainer?: string | null;
  description?: string | null;
  modelsCount?: number;
  wikiId?: string | null;
}

export function computeBenchmarkCoverage(row: BenchmarkCoverageInput): number {
  let signals = 0;

  if (row.category) signals++;
  if (row.scoringMethod) signals++;
  if (row.introducedDate) signals++;
  if (row.maintainer) signals++;
  if (row.description) signals++;
  if ((row.modelsCount ?? 0) >= 3) signals++;
  if ((row.modelsCount ?? 0) >= 10) signals++;
  if (row.wikiId) signals++;

  if (signals >= 6) return 4;
  if (signals >= 4) return 3;
  if (signals >= 2) return 2;
  return 1;
}

// ── Grant scoring ───────────────────────────────────────────────────

export interface GrantCoverageInput {
  amount?: number | null;
  recipient?: string | null;
  date?: string | null;
  program?: string | null;
  status?: string | null;
  source?: string | null;
}

export function computeGrantCoverage(row: GrantCoverageInput): number {
  let signals = 0;

  if (row.amount != null) signals++;
  if (row.recipient) signals++;
  if (row.date) signals++;
  if (row.program) signals++;
  if (row.status) signals++;
  if (row.source) signals++;

  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
  return 1;
}

// ── Funding Program scoring ─────────────────────────────────────────

export interface FundingProgramCoverageInput {
  totalBudget?: number | null;
  programType?: string | null;
  deadline?: string | null;
  status?: string | null;
  description?: string | null;
  applicationUrl?: string | null;
}

export function computeFundingProgramCoverage(row: FundingProgramCoverageInput): number {
  let signals = 0;

  if (row.totalBudget != null) signals++;
  if (row.programType) signals++;
  if (row.deadline) signals++;
  if (row.status) signals++;
  if (row.description) signals++;
  if (row.applicationUrl) signals++;

  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
  return 1;
}

// ── Funding Round scoring ───────────────────────────────────────────

export interface FundingRoundCoverageInput {
  raised?: number | null;
  valuation?: number | null;
  date?: string | null;
  instrument?: string | null;
  leadInvestorName?: string | null;
}

export function computeFundingRoundCoverage(row: FundingRoundCoverageInput): number {
  let signals = 0;

  if (row.raised != null) signals++;
  if (row.valuation != null) signals++;
  if (row.date) signals++;
  if (row.instrument) signals++;
  if (row.leadInvestorName) signals++;

  if (signals >= 4) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
  return 1;
}

// ── Division scoring ────────────────────────────────────────────────

export interface DivisionCoverageInput {
  divisionType?: string | null;
  status?: string | null;
  hasData?: boolean;
  href?: string | null;
}

export function computeDivisionCoverage(row: DivisionCoverageInput): number {
  let signals = 0;

  if (row.divisionType) signals++;
  if (row.status) signals++;
  if (row.hasData) signals++;
  if (row.href) signals++;

  if (signals >= 4) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
  return 1;
}

// ── Publication scoring ─────────────────────────────────────────────

export interface PublicationCoverageInput {
  credibility?: number | null;
  peerReviewed?: boolean;
  resourceCount?: number;
  pageCount?: number;
  type?: string | null;
}

export function computePublicationCoverage(row: PublicationCoverageInput): number {
  let signals = 0;

  if (row.credibility != null) signals++;
  if (row.peerReviewed) signals++;
  if ((row.resourceCount ?? 0) >= 1) signals++;
  if ((row.resourceCount ?? 0) >= 5) signals++;
  if ((row.pageCount ?? 0) >= 1) signals++;
  if (row.type) signals++;

  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
  return 1;
}
