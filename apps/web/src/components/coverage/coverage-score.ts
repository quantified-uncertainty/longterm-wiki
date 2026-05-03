/**
 * Entity-type-aware coverage scoring.
 *
 * Each entity type has a scoring function that examines the available data
 * and returns a 1-4 score reflecting content depth. Scoring only counts
 * fields that represent genuine enrichment beyond baseline data — fields
 * that are almost always present (name, type, etc.) are NOT counted.
 *
 * Score semantics:
 *   1 = Stub — only baseline data (name, type)
 *   2 = Basic — 1-2 enrichment fields populated
 *   3 = Moderate — substantial enrichment across multiple dimensions
 *   4 = Comprehensive — most optional fields filled, rich data
 *
 * Calibration principle: a "typical" record should score 2, not 3.
 * Score 3 should mean "notably well-documented." Score 4 should be rare.
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
  /**
   * Number of distinct external scorecards from `SCORECARD_SOURCES` that
   * have rated this org (counted in the latest wave per source). QUA-867
   * item D: an org rated by every scorecard but missing the financial
   * fields above used to score 1 ("stub") despite being one of the
   * most-evaluated frontier labs. One signal at ≥1 scorecards, a second
   * at ≥3.
   */
  externalScorecardCount?: number | null;
}

export function computeOrgCoverage(row: OrgCoverageInput): number {
  // Baseline: name + type (always present, not counted)
  // Enrichment signals: financial metrics, people tracking, wiki page,
  //   external-scorecard presence (QUA-867 item D)
  let signals = 0;

  if (row.revenueNum != null) signals++;
  if (row.valuationNum != null) signals++;
  if (row.headcount != null) signals++;
  if (row.totalFundingNum != null) signals++;
  if (row.foundedDate) signals++;
  if (row.peopleCount != null && row.peopleCount >= 10) signals++;
  if (row.wikiPageId) signals++;
  const ec = row.externalScorecardCount ?? 0;
  if (ec >= 1) signals++;
  if (ec >= 3) signals++;

  // 9 possible (was 7 before QUA-867 added the two scorecard tiers).
  // Tier thresholds (5 → 4, 3 → 3, 2 → 2) were intentionally left at the
  // pre-QUA-867 levels: the new pathway is for orgs heavily evaluated by
  // external scorecards but missing financial metadata, which previously
  // scored 1. Lowering the bar by 2 was the explicit goal — see the
  // "rescues a frontier lab" test case for the calibration.
  // Typical org has foundedDate + maybe 1 financial = 2.
  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
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
  // Baseline: name (always present, not counted)
  // Enrichment: role, employer, birth year, net worth, career depth,
  //   positions, publications, wiki page
  let signals = 0;

  if (row.role) signals++;
  if (row.employerId) signals++;
  if (row.bornYear != null) signals++;
  if (row.netWorthNum != null) signals++;
  if ((row.careerHistoryCount ?? 0) >= 3) signals++;
  if ((row.positionCount ?? 0) >= 1) signals++;
  if ((row.publicationCount ?? 0) >= 1) signals++;
  if (row.wikiPageId) signals++;

  // 8 possible. Typical person has role + employer = 2.
  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
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
  // Baseline: developer + releaseDate (almost always present, not counted)
  // Enrichment: pricing, context window, params, safety level, benchmarks, wiki
  let signals = 0;

  if (row.inputPrice != null || row.outputPrice != null) signals++;
  if (row.contextWindow != null) signals++;
  if (row.parameterCount) signals++;
  if (row.safetyLevel) signals++;
  if ((row.benchmarkCount ?? 0) >= 3) signals++;
  if (row.wikiId) signals++;

  // 6 possible. Typical model has pricing + context = 2.
  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
  return 1;
}

export function getAiModelSignals(row: AiModelCoverageInput): string[] {
  const signals: string[] = [];
  if (row.inputPrice != null || row.outputPrice != null) signals.push("Pricing");
  if (row.contextWindow != null) signals.push("Context window");
  if (row.parameterCount) signals.push("Parameter count");
  if (row.safetyLevel) signals.push("Safety level");
  if ((row.benchmarkCount ?? 0) >= 3) signals.push("Benchmarks");
  if (row.wikiId) signals.push("Wiki page");
  return signals;
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
  // Baseline: title + policyStatus + jurisdiction (common, not counted)
  // Enrichment: introduced date, author, bill number, full text, description, tags, wiki
  let signals = 0;

  if (row.introduced) signals++;
  if (row.author) signals++;
  if (row.billNumber) signals++;
  if (row.fullTextUrl) signals++;
  if (row.description) signals++;
  if ((row.tags?.length ?? 0) >= 1) signals++;
  if (row.wikiId) signals++;

  // 7 possible. Typical legislation has introduced + description = 2.
  if (signals >= 5) return 4;
  if (signals >= 3) return 3;
  if (signals >= 2) return 2;
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
  // Generic scorer for record types without a specialized function.
  // filledFieldCount should only count genuinely optional enrichment fields,
  // NOT baseline fields like name/type that are always present.
  let signals = 0;

  if (row.description) signals++;
  if ((row.tags?.length ?? 0) >= 1) signals++;
  if (row.wikiId) signals++;
  signals += Math.min(row.filledFieldCount ?? 0, 3);

  // 6 possible (3 + filledFieldCount capped at 3). Typical record has 1-2.
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
  // Baseline: name + orgName (common, not counted)
  // Enrichment: description, status, website, clusters, wiki
  let signals = 0;

  if (row.description) signals++;
  if (row.status) signals++;
  if (row.website) signals++;
  if ((row.clusters?.length ?? 0) >= 1) signals++;
  if (row.wikiId) signals++;

  // 5 possible. Typical project has description = 1.
  if (signals >= 4) return 4;
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

export function getBenchmarkSignals(row: BenchmarkCoverageInput): string[] {
  const signals: string[] = [];
  if (row.description) signals.push("Description");
  if (row.category) signals.push("Category");
  if (row.scoringMethod) signals.push("Scoring method");
  if (row.introducedDate) signals.push("Introduced date");
  if (row.maintainer) signals.push("Maintainer");
  if ((row.modelsCount ?? 0) >= 3) signals.push("3+ models tested");
  if ((row.modelsCount ?? 0) >= 10) signals.push("10+ models tested");
  if (row.wikiId) signals.push("Wiki page");
  return signals;
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
  // Baseline: recipient + amount (almost always present, not counted)
  // Enrichment: date, program, status, source
  let signals = 0;

  if (row.date) signals++;
  if (row.program) signals++;
  if (row.source) signals++;
  // Status is very rarely populated (<10%), so it's a strong signal when present
  if (row.status) signals++;

  // 4 possible. Typical grant has date = 1.
  if (signals >= 4) return 4;
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
  // Baseline: name + programType (almost always present, not counted)
  // Enrichment: budget, deadline, status, description, applicationUrl
  let signals = 0;

  if (row.totalBudget != null) signals++;
  if (row.deadline) signals++;
  if (row.status) signals++;
  if (row.description) signals++;
  if (row.applicationUrl) signals++;

  // 5 possible. Typical program has maybe status = 1.
  if (signals >= 4) return 4;
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
  // Baseline: name + raised (almost always present, not counted)
  // Enrichment: valuation, date, instrument, lead investor
  let signals = 0;

  if (row.valuation != null) signals++;
  if (row.date) signals++;
  if (row.instrument) signals++;
  if (row.leadInvestorName) signals++;

  // 4 possible. Typical round has date = 1.
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
  // Baseline: name + divisionType (almost always present, not counted)
  // Enrichment: status, has detailed data (lead/source), has detail page
  let signals = 0;

  if (row.status) signals++;
  if (row.hasData) signals++;
  if (row.href) signals++;

  // 3 possible. Typical division has status = 1.
  if (signals >= 3) return 4;
  if (signals >= 2) return 3;
  if (signals >= 1) return 2;
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

// ── Signal extraction (for popover breakdown) ───────────────────────

/** Extract human-readable signal names from an org entity. */
export function getOrgSignals(row: OrgCoverageInput): string[] {
  const signals: string[] = [];
  if (row.revenueNum != null) signals.push("Revenue");
  if (row.valuationNum != null) signals.push("Valuation");
  if (row.headcount != null) signals.push("Headcount");
  if (row.totalFundingNum != null) signals.push("Total funding");
  if (row.foundedDate) signals.push("Founded date");
  if (row.peopleCount != null && row.peopleCount >= 10) signals.push("10+ people tracked");
  if (row.wikiPageId) signals.push("Wiki page");
  const ec = row.externalScorecardCount ?? 0;
  if (ec >= 1) {
    signals.push(ec === 1 ? "1 external scorecard" : `${ec} external scorecards`);
  }
  return signals;
}

/** Extract human-readable signal names from a person entity. */
export function getPersonSignals(row: PersonCoverageInput): string[] {
  const signals: string[] = [];
  if (row.role) signals.push("Role");
  if (row.employerId) signals.push("Employer");
  if (row.bornYear != null) signals.push("Birth year");
  if (row.netWorthNum != null) signals.push("Net worth");
  if ((row.careerHistoryCount ?? 0) >= 3) signals.push(`${row.careerHistoryCount} career entries`);
  if ((row.positionCount ?? 0) >= 1) signals.push(`${row.positionCount} positions`);
  if ((row.publicationCount ?? 0) >= 1) signals.push(`${row.publicationCount} publications`);
  if (row.wikiPageId) signals.push("Wiki page");
  return signals;
}

/** Extract human-readable signal names from a legislation entity. */
export function getLegislationSignals(row: LegislationCoverageInput): string[] {
  const signals: string[] = [];
  if (row.introduced) signals.push("Introduced date");
  if (row.policyStatus) signals.push("Status");
  if (row.author) signals.push("Author");
  if (row.jurisdiction) signals.push("Jurisdiction");
  if (row.billNumber) signals.push("Bill number");
  if (row.fullTextUrl) signals.push("Full text link");
  if (row.description) signals.push("Description");
  if ((row.tags?.length ?? 0) >= 1) signals.push("Tags");
  if (row.wikiId) signals.push("Wiki page");
  return signals;
}
