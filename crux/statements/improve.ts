/**
 * Statement Improvement Pipeline — generates new statements and rewrites low-quality ones.
 *
 * Two modes:
 *   - "gaps" (default): Uses the scoring engine to detect gaps, optionally researches
 *     via web search, then generates high-quality statements via LLM. Each candidate
 *     passes through a quality gate (scoring + uniqueness) before insertion.
 *   - "quality": Scores all existing statements, rewrites those below a threshold
 *     via LLM, quality-gates the rewrites (must score higher than originals), then
 *     supersedes originals and inserts improved versions.
 *
 * Architecture: runSinglePass() is the gap-filling core. runQualityPass() is the
 * rewrite core. main() is a thin CLI wrapper that dispatches based on --mode.
 *
 * Usage:
 *   pnpm crux statements improve <entity-id> --org-type=frontier-lab
 *   pnpm crux statements improve <entity-id> --dry-run
 *   pnpm crux statements improve <entity-id> --category=safety
 *   pnpm crux statements improve <entity-id> --no-research --min-score=0.6
 *   pnpm crux statements improve <entity-id> --budget=10 --json
 *   pnpm crux statements improve <entity-id> --mode=quality --min-score=0.4
 */

import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import { parseJsonFromLlm } from '../lib/json-parsing.ts';
import { slugToDisplayName } from '../lib/claim-text-utils.ts';
import {
  createStatementBatch,
  storeCoverageScore,
  getProperties,
  getStatementsByEntity,
  patchStatement,
  type CreateStatementInput,
} from '../lib/wiki-server/statements.ts';
import { analyzeGaps, type GapAnalysis } from './gaps.ts';
import {
  scoreStatement,
  scoreUniqueness,
  scoreAllStatements,
  type ScoringStatement,
  type ScoringContext,
  type ScoringResult,
} from './scoring.ts';
import { resolveCoverageTargets } from './coverage-targets.ts';

// ---------------------------------------------------------------------------
// Types (exported for use by future pass functions)
// ---------------------------------------------------------------------------

export interface GeneratedStatement {
  statementText: string;
  propertyId: string;
  variety: 'structured' | 'attributed';
  valueText?: string | null;
  valueNumeric?: number | null;
  valueUnit?: string | null;
  valueDate?: string | null;
  validStart?: string | null;
  citations?: Array<{
    url?: string | null;
    sourceQuote?: string | null;
  }>;
}

export interface GateResult {
  accepted: CreateStatementInput[];
  rejected: Array<{
    statement: GeneratedStatement;
    reason: string;
    score: number;
  }>;
}

/** Options for a single improvement pass. */
export interface ImproveOptions {
  entityId: string;
  orgType?: string | null;
  categoryFilter?: string | null;
  minScore: number;
  budget: number;
  noResearch: boolean;
  dryRun: boolean;
  client: Anthropic;
  tracker: CostTracker;
}

/** Result of a single improvement pass. */
export interface PassResult {
  entityId: string;
  entityType: string;
  categoriesProcessed: string[];
  coverageBefore: number;
  coverageAfter: number | null;
  created: number;
  rejected: number;
  totalCost: number;
  rejections: Array<{ text: string; reason: string; score: number }>;
}

// ---------------------------------------------------------------------------
// Statement generation
// ---------------------------------------------------------------------------

export async function generateStatements(
  entityId: string,
  entityName: string,
  entityType: string,
  category: string,
  deficit: number,
  properties: Array<{ id: string; label: string; description: string | null }>,
  existingTexts: string[],
  sources: string | null,
  client: Anthropic,
  tracker: CostTracker,
): Promise<GeneratedStatement[]> {
  const propertyList = properties
    .map((p) => `  - ${p.id}: ${p.label}${p.description ? ` — ${p.description}` : ''}`)
    .join('\n');

  const existingList = existingTexts.length > 0
    ? `\nExisting statements in this category (do NOT duplicate these):\n${existingTexts.map((t) => `  - ${t}`).join('\n')}`
    : '';

  const sourceSection = sources
    ? `\nResearch sources with relevant facts:\n${sources}`
    : '';

  const prompt = {
    system: `You are a structured data expert generating high-quality factual statements about entities for a knowledge base. Each statement must be:
- Atomic: exactly one fact per statement
- Self-contained: mentions the entity by name
- Precise: uses specific numbers, dates, or named entities when possible
- Verifiable: could be checked against public sources
- Well-structured: uses appropriate property IDs from the vocabulary

Respond ONLY with a JSON array of statement objects.`,
    user: `Generate ${deficit} high-quality "${category}" statements about ${entityName} (${entityType}).

Available properties for this category:
${propertyList}
${existingList}
${sourceSection}

Return a JSON array where each element has:
- "statementText": string — a complete, self-contained sentence mentioning "${entityName}"
- "propertyId": string — one of the property IDs listed above
- "variety": "structured" or "attributed"
- "valueText": string | null — structured value if applicable
- "valueNumeric": number | null — numeric value if applicable
- "valueUnit": string | null — unit for numeric values
- "valueDate": string | null — ISO date if the value is a date
- "validStart": string | null — when this fact became true (YYYY or YYYY-MM-DD)
- "citations": [{"url": string | null, "sourceQuote": string | null}] — source citations if available

Generate exactly ${deficit} statements. Focus on the most important, well-known facts first.`,
  };

  const result = await callLlm(client, prompt, {
    model: MODELS.sonnet,
    maxTokens: 4000,
    temperature: 0.3,
    retryLabel: 'improve-generate',
    tracker,
    label: `generate-${category}`,
  });

  const parsed = parseJsonFromLlm<GeneratedStatement[]>(
    result.text,
    'improve-generate',
    () => [],
  );

  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (s) => s && typeof s.statementText === 'string' && s.statementText.length > 10,
  );
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

export function qualityGate(
  generated: GeneratedStatement[],
  entityId: string,
  entityName: string,
  existingSiblings: ScoringStatement[],
  minScore: number,
  propertyMap?: Map<string, { id: string; label: string; category: string; stalenessCadence?: string | null }>,
): GateResult {
  const accepted: CreateStatementInput[] = [];
  const rejected: GateResult['rejected'] = [];

  // Build scoring siblings: existing + previously accepted (for cross-checking)
  const allSiblings = [...existingSiblings];
  let nextId = -1; // temporary negative IDs for scoring

  for (const gen of generated) {
    // Resolve property metadata for scoring (importance depends on category)
    const propMeta = gen.propertyId && propertyMap ? propertyMap.get(gen.propertyId) : null;

    // Build a temporary ScoringStatement for scoring
    const tempStmt: ScoringStatement = {
      id: nextId--,
      variety: gen.variety ?? 'structured',
      statementText: gen.statementText,
      subjectEntityId: entityId,
      propertyId: gen.propertyId ?? null,
      valueNumeric: gen.valueNumeric ?? null,
      valueUnit: gen.valueUnit ?? null,
      valueText: gen.valueText ?? null,
      valueEntityId: null,
      valueDate: gen.valueDate ?? null,
      validStart: gen.validStart ?? null,
      validEnd: null,
      status: 'active',
      claimCategory: null,
      citations: gen.citations?.map((c) => ({
        resourceId: null,
        url: c.url ?? null,
        sourceQuote: c.sourceQuote ?? null,
      })),
      property: propMeta ? {
        id: propMeta.id,
        label: propMeta.label,
        category: propMeta.category,
        stalenessCadence: propMeta.stalenessCadence,
      } : null,
    };

    // Check uniqueness against all siblings (existing + already-accepted)
    const uniqueness = scoreUniqueness(tempStmt, allSiblings);
    if (uniqueness < 0.3) {
      rejected.push({
        statement: gen,
        reason: `Near-duplicate (uniqueness=${uniqueness.toFixed(3)})`,
        score: uniqueness,
      });
      continue;
    }

    // Full quality scoring
    const ctx: ScoringContext = {
      siblings: allSiblings,
      entityId,
      entityName,
    };
    const result = scoreStatement(tempStmt, ctx);

    if (result.qualityScore < minScore) {
      rejected.push({
        statement: gen,
        reason: `Below quality threshold (score=${result.qualityScore.toFixed(3)}, min=${minScore})`,
        score: result.qualityScore,
      });
      continue;
    }

    // Accept — convert to CreateStatementInput
    const input: CreateStatementInput = {
      variety: gen.variety ?? 'structured',
      statementText: gen.statementText,
      subjectEntityId: entityId,
      propertyId: gen.propertyId ?? undefined,
      valueText: gen.valueText,
      valueNumeric: gen.valueNumeric,
      valueUnit: gen.valueUnit,
      valueDate: gen.valueDate,
      validStart: gen.validStart,
      citations: gen.citations?.map((c) => ({
        url: c.url,
        sourceQuote: c.sourceQuote,
      })),
    };

    accepted.push(input);
    allSiblings.push(tempStmt); // include in sibling set for subsequent checks
  }

  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// Research helper
// ---------------------------------------------------------------------------

export async function runResearchForCategory(
  entityName: string,
  entityType: string,
  entityId: string,
  category: string,
  tracker: CostTracker,
  budget: number,
): Promise<string | null> {
  try {
    const { runResearch } = await import('../lib/search/research-agent.ts');
    const result = await runResearch({
      topic: `${entityName} ${category}`,
      pageContext: { title: entityName, type: entityType, entityId },
      budgetCap: budget,
      tracker,
      config: { maxResultsPerSource: 4, maxUrlsToFetch: 8, factsPerSource: 3 },
    });

    if (result.sources.length === 0) return null;

    return result.sources
      .slice(0, 5)
      .map((s) => {
        const facts = (s.facts ?? []).map((f: string) => `    - ${f}`).join('\n');
        return `  Source: ${s.title ?? s.url}\n  URL: ${s.url}\n${facts ? `  Facts:\n${facts}` : ''}`;
      })
      .join('\n\n');
  } catch (e: unknown) {
    console.warn(`[improve] Research failed for ${category}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers: convert analysis data to scoring format
// ---------------------------------------------------------------------------

export function buildScoringContext(
  analysis: GapAnalysis,
  entityId: string,
): { existingByCategory: Map<string, string[]>; existingScoringStmts: ScoringStatement[] } {
  const existingByCategory = new Map<string, string[]>();
  const existingScoringStmts: ScoringStatement[] = [];

  for (const stmt of analysis.allStatements) {
    const prop = stmt.propertyId ? analysis.propertyMap.get(stmt.propertyId) : null;
    const cat = prop?.category ?? 'uncategorized';
    const list = existingByCategory.get(cat) ?? [];
    list.push(stmt.statementText ?? '');
    existingByCategory.set(cat, list);

    existingScoringStmts.push({
      id: stmt.id as number,
      variety: stmt.variety as string,
      statementText: (stmt.statementText as string) ?? null,
      subjectEntityId: (stmt.subjectEntityId as string) ?? entityId,
      propertyId: (stmt.propertyId as string) ?? null,
      valueNumeric: null,
      valueUnit: null,
      valueText: null,
      valueEntityId: null,
      valueDate: null,
      validStart: null,
      validEnd: null,
      status: 'active',
      claimCategory: null,
    });
  }

  return { existingByCategory, existingScoringStmts };
}

export function buildPropertyMap(
  allProperties: Array<{ id: string; label: string; category: string; stalenessCadence: string | null }>,
): Map<string, { id: string; label: string; category: string; stalenessCadence?: string | null }> {
  return new Map(
    allProperties.map((p) => [p.id, {
      id: p.id,
      label: p.label,
      category: p.category,
      stalenessCadence: p.stalenessCadence,
    }]),
  );
}

// ---------------------------------------------------------------------------
// Core: single improvement pass (composable)
// ---------------------------------------------------------------------------

/**
 * Run one pass of gap-filling statement generation.
 *
 * This is the composable core — it takes explicit options and returns a result
 * object. No CLI parsing, no process.exit(), no console output.
 * The caller (main() or an iteration wrapper) handles those concerns.
 */
export async function runSinglePass(opts: ImproveOptions): Promise<PassResult> {
  const { entityId, orgType, categoryFilter, minScore, budget, noResearch, dryRun, client, tracker } = opts;
  const entityName = slugToDisplayName(entityId);

  // 1. Analyze gaps
  const analysis = await analyzeGaps(entityId, orgType);
  const coverageBefore = analysis.coverageScore;

  // Filter to gaps with deficit > 0
  let targetGaps = analysis.gaps.filter((g) => g.deficit > 0);
  if (categoryFilter) {
    targetGaps = targetGaps.filter((g) => g.category === categoryFilter);
  }

  if (targetGaps.length === 0) {
    return {
      entityId,
      entityType: analysis.entityType,
      categoriesProcessed: [],
      coverageBefore,
      coverageAfter: coverageBefore,
      created: 0,
      rejected: 0,
      totalCost: tracker.totalCost,
      rejections: [],
    };
  }

  // Cap to top 5 gaps by priority
  targetGaps = targetGaps.slice(0, 5);

  // 2. Fetch properties
  const propResult = await getProperties();
  const allProperties = propResult.ok ? propResult.data.properties : [];
  const fullPropertyMap = buildPropertyMap(allProperties);

  // 3. Build existing statement context
  const { existingByCategory, existingScoringStmts } = buildScoringContext(analysis, entityId);

  // 4. Process each gap category
  let totalCreated = 0;
  let totalRejected = 0;
  const allRejections: PassResult['rejections'] = [];
  const categoriesProcessed: string[] = [];
  const allAccepted: CreateStatementInput[] = [];
  const budgetPerCategory = budget / targetGaps.length;

  for (const gap of targetGaps) {
    if (tracker.totalCost >= budget) break;

    categoriesProcessed.push(gap.category);

    // Research (optional)
    let sources: string | null = null;
    if (!noResearch) {
      sources = await runResearchForCategory(
        entityName,
        analysis.entityType,
        entityId,
        gap.category,
        tracker,
        Math.min(budgetPerCategory * 0.5, 1.0),
      );
    }

    // Filter properties to this category
    const categoryProps = allProperties.filter((p) => p.category === gap.category);

    // Generate
    const generated = await generateStatements(
      entityId,
      entityName,
      analysis.entityType,
      gap.category,
      gap.deficit,
      categoryProps,
      existingByCategory.get(gap.category) ?? [],
      sources,
      client,
      tracker,
    );

    // Quality gate
    const gateResult = qualityGate(generated, entityId, entityName, existingScoringStmts, minScore, fullPropertyMap);

    totalCreated += gateResult.accepted.length;
    totalRejected += gateResult.rejected.length;
    allAccepted.push(...gateResult.accepted);

    for (const r of gateResult.rejected) {
      allRejections.push({
        text: r.statement.statementText.slice(0, 80),
        reason: r.reason,
        score: r.score,
      });
    }
  }

  // 5. Insert (unless dry-run)
  let coverageAfter: number | null = null;

  if (!dryRun && allAccepted.length > 0) {
    const batchResult = await createStatementBatch(allAccepted);
    if (!batchResult.ok) {
      throw new Error('Failed to insert statements');
    }

    // Re-analyze to get updated coverage
    try {
      const updated = await analyzeGaps(entityId, orgType);
      coverageAfter = updated.coverageScore;

      const targets = resolveCoverageTargets(updated.entityType, orgType);
      if (targets) {
        await storeCoverageScore({
          entityId,
          coverageScore: updated.coverageScore,
          categoryScores: Object.fromEntries(
            Object.entries(updated.categoryCounts).map(([cat, count]) => {
              const target = targets[cat];
              return [cat, target ? Math.min(1, count / target) : 0];
            }),
          ),
          statementCount: updated.totalStatements,
        });
      }
    } catch (e: unknown) {
      // Best-effort: coverage re-score is not critical to the improve pipeline
      console.warn(`[improve] Coverage re-score failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    entityId,
    entityType: analysis.entityType,
    categoriesProcessed,
    coverageBefore,
    coverageAfter,
    created: totalCreated,
    rejected: totalRejected,
    totalCost: tracker.totalCost,
    rejections: allRejections,
  };
}

// ---------------------------------------------------------------------------
// Quality pass: rewrite low-scoring statements
// ---------------------------------------------------------------------------

/**
 * Generate a rewrite of a low-quality statement via LLM.
 * Returns a GeneratedStatement with improved structure, citations, and clarity.
 */
export async function generateRewrite(
  original: ScoringStatement,
  entityName: string,
  entityType: string,
  properties: Array<{ id: string; label: string; description: string | null }>,
  client: Anthropic,
  tracker: CostTracker,
): Promise<GeneratedStatement | null> {
  const propertyList = properties
    .map((p) => `  - ${p.id}: ${p.label}${p.description ? ` — ${p.description}` : ''}`)
    .join('\n');

  const originalInfo = [
    `Text: "${original.statementText ?? ''}"`,
    original.propertyId ? `Property: ${original.propertyId}` : null,
    original.valueText ? `Value: ${original.valueText}` : null,
    original.valueNumeric != null ? `Numeric: ${original.valueNumeric}${original.valueUnit ? ` ${original.valueUnit}` : ''}` : null,
    original.validStart ? `Valid from: ${original.validStart}` : null,
  ].filter(Boolean).join('\n  ');

  const prompt = {
    system: `You are a structured data expert improving low-quality statements in a knowledge base. Your goal is to rewrite statements to be:
- Atomic: exactly one fact per statement
- Self-contained: mentions the entity "${entityName}" by name
- Precise: uses specific numbers, dates, or named entities
- Verifiable: includes citation URLs and source quotes when possible
- Well-structured: uses appropriate property IDs and typed values

Respond ONLY with a JSON object (not an array).`,
    user: `Rewrite this low-quality statement about ${entityName} (${entityType}) to be higher quality.

Original statement:
  ${originalInfo}

Available properties:
${propertyList}

Return a JSON object with:
- "statementText": string — a complete, self-contained sentence mentioning "${entityName}"
- "propertyId": string — one of the property IDs listed above (keep the original if appropriate)
- "variety": "structured" or "attributed"
- "valueText": string | null — structured value if applicable
- "valueNumeric": number | null — numeric value if applicable
- "valueUnit": string | null — unit for numeric values
- "valueDate": string | null — ISO date if the value is a date
- "validStart": string | null — when this fact became true (YYYY or YYYY-MM-DD)
- "citations": [{"url": string | null, "sourceQuote": string | null}] — source citations

Preserve the core factual content but improve structure, precision, and add citations if possible.`,
  };

  const result = await callLlm(client, prompt, {
    model: MODELS.sonnet,
    maxTokens: 2000,
    temperature: 0.3,
    retryLabel: 'improve-rewrite',
    tracker,
    label: `rewrite-${original.id}`,
  });

  const parsed = parseJsonFromLlm<GeneratedStatement>(
    result.text,
    'improve-rewrite',
    () => null as unknown as GeneratedStatement,
  );

  if (!parsed || typeof parsed.statementText !== 'string' || parsed.statementText.length < 10) {
    return null;
  }

  return parsed;
}

/**
 * Convert a by-entity API response statement to a ScoringStatement.
 * The API returns statements with property and citation info joined.
 */
export function toScoringStatement(stmt: {
  id: number;
  variety: string;
  statementText: string | null;
  subjectEntityId: string;
  propertyId: string | null;
  valueNumeric: number | string | null;
  valueUnit: string | null;
  valueText: string | null;
  valueEntityId: string | null;
  valueDate: string | null;
  validStart: string | null;
  validEnd: string | null;
  status: string;
  claimCategory: string | null;
  property?: { id: string; label: string; category: string; stalenessCadence?: string | null } | null;
  citations?: Array<{ resourceId?: string | null; url?: string | null; sourceQuote?: string | null }>;
}): ScoringStatement {
  return {
    id: stmt.id,
    variety: stmt.variety,
    statementText: stmt.statementText,
    subjectEntityId: stmt.subjectEntityId,
    propertyId: stmt.propertyId,
    valueNumeric: typeof stmt.valueNumeric === 'string' ? parseFloat(stmt.valueNumeric) : stmt.valueNumeric,
    valueUnit: stmt.valueUnit,
    valueText: stmt.valueText,
    valueEntityId: stmt.valueEntityId,
    valueDate: stmt.valueDate,
    validStart: stmt.validStart,
    validEnd: stmt.validEnd,
    status: stmt.status,
    claimCategory: stmt.claimCategory,
    property: stmt.property ? {
      id: stmt.property.id,
      label: stmt.property.label,
      category: stmt.property.category,
      stalenessCadence: stmt.property.stalenessCadence ?? null,
    } : null,
    citations: stmt.citations?.map((c) => ({
      resourceId: c.resourceId ?? null,
      url: c.url ?? null,
      sourceQuote: c.sourceQuote ?? null,
    })),
  };
}

/**
 * Quality-gate a single rewrite against its original.
 * Returns the new ScoringResult if the rewrite scores higher, null otherwise.
 */
export function qualityGateRewrite(
  rewrite: GeneratedStatement,
  originalScore: number,
  entityId: string,
  entityName: string,
  siblings: ScoringStatement[],
  propertyMap: Map<string, { id: string; label: string; category: string; stalenessCadence?: string | null }>,
): { accepted: boolean; newScore: number; reason: string } {
  const propMeta = rewrite.propertyId ? propertyMap.get(rewrite.propertyId) : null;

  const tempStmt: ScoringStatement = {
    id: -1,
    variety: rewrite.variety ?? 'structured',
    statementText: rewrite.statementText,
    subjectEntityId: entityId,
    propertyId: rewrite.propertyId ?? null,
    valueNumeric: rewrite.valueNumeric ?? null,
    valueUnit: rewrite.valueUnit ?? null,
    valueText: rewrite.valueText ?? null,
    valueEntityId: null,
    valueDate: rewrite.valueDate ?? null,
    validStart: rewrite.validStart ?? null,
    validEnd: null,
    status: 'active',
    claimCategory: null,
    citations: rewrite.citations?.map((c) => ({
      resourceId: null,
      url: c.url ?? null,
      sourceQuote: c.sourceQuote ?? null,
    })),
    property: propMeta ? {
      id: propMeta.id,
      label: propMeta.label,
      category: propMeta.category,
      stalenessCadence: propMeta.stalenessCadence,
    } : null,
  };

  const ctx: ScoringContext = { siblings, entityId, entityName };
  const result = scoreStatement(tempStmt, ctx);

  if (result.qualityScore <= originalScore) {
    return {
      accepted: false,
      newScore: result.qualityScore,
      reason: `Rewrite did not improve score (${result.qualityScore.toFixed(3)} <= ${originalScore.toFixed(3)})`,
    };
  }

  return {
    accepted: true,
    newScore: result.qualityScore,
    reason: `Improved ${originalScore.toFixed(3)} -> ${result.qualityScore.toFixed(3)}`,
  };
}

/**
 * Run one pass of quality-based statement rewriting.
 *
 * Fetches all statements for the entity, scores them, filters to those below
 * the threshold, generates rewrites via LLM, quality-gates each rewrite
 * (must score higher than original), then supersedes originals and creates
 * the improved versions.
 */
export async function runQualityPass(opts: ImproveOptions): Promise<PassResult> {
  const { entityId, categoryFilter, minScore, budget, dryRun, client, tracker } = opts;
  const entityName = slugToDisplayName(entityId);

  // 1. Fetch all statements for the entity
  const stmtResult = await getStatementsByEntity(entityId);
  if (!stmtResult.ok) {
    throw new Error(`Could not fetch statements for ${entityId}`);
  }

  const allRawStatements = [
    ...stmtResult.data.structured,
    ...stmtResult.data.attributed,
  ];

  // Convert to ScoringStatements
  const scoringStmts: ScoringStatement[] = allRawStatements.map((s) =>
    toScoringStatement(s as Parameters<typeof toScoringStatement>[0]),
  );

  // 2. Score all statements
  const scores = scoreAllStatements(scoringStmts, entityId, entityName);
  const scoreMap = new Map<number, ScoringResult>(scores.map((s) => [s.statementId, s]));

  // 3. Filter to low-quality statements
  let lowQuality = scores.filter((s) => s.qualityScore < minScore);

  // Apply category filter if specified
  if (categoryFilter) {
    lowQuality = lowQuality.filter((s) => {
      const stmt = scoringStmts.find((st) => st.id === s.statementId);
      return stmt?.property?.category === categoryFilter;
    });
  }

  if (lowQuality.length === 0) {
    const entityResult = await import('../lib/wiki-server/entities.ts').then(
      (m) => m.getEntity(entityId),
    );
    const entityType = entityResult.ok && entityResult.data.entityType
      ? entityResult.data.entityType
      : 'organization';

    return {
      entityId,
      entityType,
      categoriesProcessed: [],
      coverageBefore: 0,
      coverageAfter: null,
      created: 0,
      rejected: 0,
      totalCost: tracker.totalCost,
      rejections: [],
    };
  }

  // 4. Fetch properties for rewrite generation
  const propResult = await getProperties();
  const allProperties = propResult.ok ? propResult.data.properties : [];
  const fullPropertyMap = buildPropertyMap(allProperties);

  // Determine entity type
  const entityResult = await import('../lib/wiki-server/entities.ts').then(
    (m) => m.getEntity(entityId),
  );
  const entityType = entityResult.ok && entityResult.data.entityType
    ? entityResult.data.entityType
    : 'organization';

  // 5. Process each low-quality statement
  let totalCreated = 0;
  let totalRejected = 0;
  const allRejections: PassResult['rejections'] = [];
  const categoriesProcessed = new Set<string>();
  const rewrites: Array<{ originalId: number; input: CreateStatementInput }> = [];

  for (const scored of lowQuality) {
    if (tracker.totalCost >= budget) break;

    const original = scoringStmts.find((s) => s.id === scored.statementId);
    if (!original) continue;

    const category = original.property?.category ?? 'uncategorized';
    categoriesProcessed.add(category);

    // Filter properties to this category
    const categoryProps = allProperties.filter((p) => p.category === category);

    // Generate rewrite
    const rewrite = await generateRewrite(
      original,
      entityName,
      entityType,
      categoryProps,
      client,
      tracker,
    );

    if (!rewrite) {
      totalRejected++;
      allRejections.push({
        text: (original.statementText ?? '').slice(0, 80),
        reason: 'LLM failed to generate a valid rewrite',
        score: scored.qualityScore,
      });
      continue;
    }

    // Quality gate: rewrite must score higher than original
    const gateResult = qualityGateRewrite(
      rewrite,
      scored.qualityScore,
      entityId,
      entityName,
      scoringStmts,
      fullPropertyMap,
    );

    if (!gateResult.accepted) {
      totalRejected++;
      allRejections.push({
        text: rewrite.statementText.slice(0, 80),
        reason: gateResult.reason,
        score: gateResult.newScore,
      });
      continue;
    }

    // Accept — build CreateStatementInput
    const input: CreateStatementInput = {
      variety: rewrite.variety ?? 'structured',
      statementText: rewrite.statementText,
      subjectEntityId: entityId,
      propertyId: rewrite.propertyId ?? undefined,
      valueText: rewrite.valueText,
      valueNumeric: rewrite.valueNumeric,
      valueUnit: rewrite.valueUnit,
      valueDate: rewrite.valueDate,
      validStart: rewrite.validStart,
      citations: rewrite.citations?.map((c) => ({
        url: c.url,
        sourceQuote: c.sourceQuote,
      })),
    };

    rewrites.push({ originalId: original.id, input });
    totalCreated++;
  }

  // 6. Apply rewrites (unless dry-run)
  if (!dryRun && rewrites.length > 0) {
    // Supersede originals
    for (const { originalId } of rewrites) {
      const patchResult = await patchStatement(originalId, {
        status: 'superseded',
        archiveReason: 'Superseded by quality rewrite',
      });
      if (!patchResult.ok) {
        console.warn(`[improve] Failed to supersede statement ${originalId}`);
      }
    }

    // Create new statements
    const batchResult = await createStatementBatch(rewrites.map((r) => r.input));
    if (!batchResult.ok) {
      throw new Error('Failed to insert rewritten statements');
    }
  }

  return {
    entityId,
    entityType,
    categoriesProcessed: Array.from(categoriesProcessed),
    coverageBefore: 0, // not applicable for quality mode
    coverageAfter: null,
    created: totalCreated,
    rejected: totalRejected,
    totalCost: tracker.totalCost,
    rejections: allRejections,
  };
}

// ---------------------------------------------------------------------------
// CLI: main (thin wrapper)
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const jsonOutput = args.json === true;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];
  const mode = (args.mode as string) ?? 'gaps';

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements improve <entity-id> [options]`);
    console.error(`  Options: --mode=gaps|quality --org-type=TYPE --dry-run --category=CAT --no-research --min-score=N --budget=N --json`);
    process.exit(1);
  }

  if (mode !== 'gaps' && mode !== 'quality') {
    console.error(`${c.red}Error: --mode must be "gaps" or "quality"${c.reset}`);
    process.exit(1);
  }

  const tracker = new CostTracker();
  const client = createLlmClient();

  const defaultMinScore = mode === 'quality' ? 0.4 : 0.5;

  const opts: ImproveOptions = {
    entityId,
    orgType: (args['org-type'] as string) ?? null,
    categoryFilter: (args.category as string) ?? null,
    minScore: typeof args['min-score'] === 'number' ? args['min-score'] : defaultMinScore,
    budget: typeof args.budget === 'number' ? args.budget : 5,
    noResearch: args['no-research'] === true,
    dryRun: args['dry-run'] === true,
    client,
    tracker,
  };

  const modeLabel = mode === 'quality' ? 'Scoring and rewriting low-quality statements' : 'Analyzing coverage gaps';
  if (!jsonOutput) console.log(`${c.dim}${modeLabel} for ${entityId}...${c.reset}`);

  let result: PassResult;
  try {
    result = mode === 'quality'
      ? await runQualityPass(opts)
      : await runSinglePass(opts);
  } catch (err) {
    console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const summaryTitle = mode === 'quality' ? 'Quality Rewrite Summary' : 'Improvement Summary';
    const createdLabel = mode === 'quality' ? 'Rewritten' : 'Created';
    console.log(`\n${c.bold}${c.blue}${summaryTitle}: ${entityId}${c.reset}`);
    console.log(`  Mode:        ${mode}`);
    console.log(`  Categories:  ${result.categoriesProcessed.join(', ') || '(none — no low-quality statements)'}`);
    console.log(`  ${createdLabel}:    ${c.green}${result.created}${c.reset}`);
    console.log(`  Rejected:    ${c.red}${result.rejected}${c.reset}`);
    if (mode === 'gaps') {
      console.log(`  Coverage:    ${result.coverageBefore.toFixed(3)}${result.coverageAfter != null ? ` -> ${result.coverageAfter.toFixed(3)}` : ''}`);
    }
    console.log(`  Cost:        $${result.totalCost.toFixed(4)}`);
    if (opts.dryRun) {
      console.log(`  ${c.dim}(dry run — no changes were applied)${c.reset}`);
    }
    console.log('');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement improvement failed:', err);
    process.exit(1);
  });
}
