/**
 * Statement Improvement Pipeline — generates new statements to fill coverage gaps.
 *
 * Uses the scoring engine (Phase A) to detect gaps, optionally researches via
 * web search, then generates high-quality statements via LLM. Each candidate
 * passes through a quality gate (scoring + uniqueness) before insertion.
 *
 * Architecture: runSinglePass() is the composable core. main() is a thin CLI
 * wrapper. Future features (quality mode, iterative loops) add new pass
 * functions alongside runSinglePass() without modifying it.
 *
 * Usage:
 *   pnpm crux statements improve <entity-id> --org-type=frontier-lab
 *   pnpm crux statements improve <entity-id> --dry-run
 *   pnpm crux statements improve <entity-id> --category=safety
 *   pnpm crux statements improve <entity-id> --no-research --min-score=0.6
 *   pnpm crux statements improve <entity-id> --budget=10 --json
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
import { getEntity } from '../lib/wiki-server/entities.ts';
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a date string from LLM output to a valid ISO date (YYYY-MM-DD) or null.
 * LLMs often produce partial dates like "2024" or "2024-06" which fail PostgreSQL date columns.
 */
function normalizeValueDate(d: string | null | undefined): string | null {
  if (!d) return null;
  // Full ISO date: YYYY-MM-DD → keep as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  // Year-month: YYYY-MM → append -01
  if (/^\d{4}-\d{2}$/.test(d)) return `${d}-01`;
  // Year only: YYYY → append -01-01
  if (/^\d{4}$/.test(d)) return `${d}-01-01`;
  // Anything else (ISO datetime, etc.) — try to parse
  const parsed = new Date(d);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null; // Unparseable — drop it
}

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

/** Options for an iterative improvement loop. */
export interface IterativeOptions extends ImproveOptions {
  targetCoverage: number;
  maxIterations: number;
}

/** Result of an iterative improvement loop. */
export interface IterativeResult {
  passes: PassResult[];
  finalCoverage: number;
  converged: boolean;  // true if target reached
  stalled: boolean;    // true if no improvement in last pass
  totalCreated: number;
  totalRejected: number;
  totalCost: number;
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
    // Validate propertyId exists in the vocabulary — FK constraint
    const validPropId = gen.propertyId && propertyMap?.has(gen.propertyId)
      ? gen.propertyId
      : undefined;

    const input: CreateStatementInput = {
      variety: gen.variety ?? 'structured',
      statementText: gen.statementText,
      subjectEntityId: entityId,
      propertyId: validPropId,
      valueText: gen.valueText,
      valueNumeric: gen.valueNumeric,
      valueUnit: gen.valueUnit,
      valueDate: normalizeValueDate(gen.valueDate),
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
// Quality mode: rewrite low-scoring statements
// ---------------------------------------------------------------------------

/**
 * Generate a rewritten version of a low-scoring statement via LLM.
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

  const prompt = {
    system: `You are a structured data expert improving low-quality factual statements for a knowledge base. Your rewrite must:
- Be atomic: exactly one fact per statement
- Be self-contained: mention the entity by name
- Be precise: use specific numbers, dates, or named entities when possible
- Be verifiable: could be checked against public sources
- Preserve the core factual claim while improving clarity and structure

Respond ONLY with a JSON object (not an array).`,
    user: `Rewrite this statement about ${entityName} (${entityType}) to improve its quality:

Original: "${original.statementText}"
Property: ${original.propertyId ?? 'none'}
Variety: ${original.variety}

Available properties:
${propertyList}

Return a JSON object with:
- "statementText": string — improved, self-contained sentence mentioning "${entityName}"
- "propertyId": string — best-matching property ID from the list above
- "variety": "structured" or "attributed"
- "valueText": string | null
- "valueNumeric": number | null
- "valueUnit": string | null
- "valueDate": string | null
- "validStart": string | null — when this fact became true (YYYY or YYYY-MM-DD)
- "citations": [{"url": string | null, "sourceQuote": string | null}]

Preserve the original fact. Improve structure, clarity, and completeness.`,
  };

  const result = await callLlm(client, prompt, {
    model: MODELS.sonnet,
    maxTokens: 2000,
    temperature: 0.2,
    retryLabel: 'improve-rewrite',
    tracker,
    label: `rewrite-${original.id}`,
  });

  const parsed = parseJsonFromLlm<GeneratedStatement>(
    result.text,
    'improve-rewrite',
    () => null,
  );

  if (!parsed || typeof parsed.statementText !== 'string' || parsed.statementText.length < 10) {
    return null;
  }

  return parsed;
}

/**
 * Convert a raw statement row from the API to a ScoringStatement.
 */
export function toScoringStatement(stmt: {
  id: number;
  variety: string;
  statementText: string | null;
  subjectEntityId: string | null;
  propertyId: string | null;
  valueNumeric?: number | string | null;
  valueUnit?: string | null;
  valueText?: string | null;
  valueEntityId?: string | null;
  valueDate?: string | null;
  validStart?: string | null;
  validEnd?: string | null;
  status?: string | null;
  claimCategory?: string | null;
  citations?: Array<{
    resourceId?: string | null;
    url?: string | null;
    sourceQuote?: string | null;
  }>;
  property?: {
    id: string;
    label: string;
    category: string;
    stalenessCadence?: string | null;
  } | null;
}): ScoringStatement {
  return {
    id: stmt.id,
    variety: stmt.variety ?? 'structured',
    statementText: stmt.statementText ?? '',
    subjectEntityId: stmt.subjectEntityId ?? '',
    propertyId: stmt.propertyId ?? null,
    valueNumeric: typeof stmt.valueNumeric === 'string'
      ? parseFloat(stmt.valueNumeric) || null
      : (stmt.valueNumeric ?? null),
    valueUnit: stmt.valueUnit ?? null,
    valueText: stmt.valueText ?? null,
    valueEntityId: stmt.valueEntityId ?? null,
    valueDate: stmt.valueDate ?? null,
    validStart: stmt.validStart ?? null,
    validEnd: stmt.validEnd ?? null,
    status: (stmt.status as string) ?? 'active',
    claimCategory: stmt.claimCategory ?? null,
    citations: stmt.citations?.map((c) => ({
      resourceId: c.resourceId ?? null,
      url: c.url ?? null,
      sourceQuote: c.sourceQuote ?? null,
    })),
    property: stmt.property ?? null,
  };
}

/**
 * Quality gate for a rewritten statement: must score higher than the original.
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

  // Check uniqueness against siblings (excluding the original)
  const uniqueness = scoreUniqueness(tempStmt, siblings);
  if (uniqueness < 0.2) {
    return { accepted: false, newScore: 0, reason: `Near-duplicate of another statement (uniqueness=${uniqueness.toFixed(3)})` };
  }

  const ctx: ScoringContext = { siblings, entityId, entityName };
  const result = scoreStatement(tempStmt, ctx);

  if (result.qualityScore <= originalScore) {
    return {
      accepted: false,
      newScore: result.qualityScore,
      reason: `Rewrite not better (${result.qualityScore.toFixed(3)} <= original ${originalScore.toFixed(3)})`,
    };
  }

  return { accepted: true, newScore: result.qualityScore, reason: 'Improved' };
}

/**
 * Quality mode: find low-scoring statements and rewrite them.
 *
 * Scores all statements for an entity, picks the bottom N by quality,
 * generates rewrites via LLM, quality-gates them (must score higher),
 * then supersedes originals and inserts new versions.
 */
export async function runQualityPass(opts: ImproveOptions): Promise<PassResult> {
  const { entityId, minScore, budget, dryRun, client, tracker } = opts;

  // Fetch entity info and statements in parallel
  const [entityResult, stmtsResult, propResult] = await Promise.all([
    getEntity(entityId),
    getStatementsByEntity(entityId),
    getProperties(),
  ]);

  const entityName = entityResult.ok
    ? (entityResult.data as { name?: string }).name ?? slugToDisplayName(entityId)
    : slugToDisplayName(entityId);
  const entityType = entityResult.ok
    ? (entityResult.data as { entityType?: string }).entityType ?? 'organization'
    : 'organization';

  if (!stmtsResult.ok) {
    throw new Error(`Failed to fetch statements for ${entityId}: ${stmtsResult.message}`);
  }

  const rawStatements = [
    ...stmtsResult.data.structured,
    ...stmtsResult.data.attributed,
  ];
  const allProperties = propResult.ok ? propResult.data.properties : [];
  const fullPropertyMap = buildPropertyMap(allProperties);

  // Convert to scoring format and score all
  const scoringStmts = rawStatements
    .filter((s) => s.status === 'active')
    .map(toScoringStatement);

  const scores = scoreAllStatements(scoringStmts, entityId, entityName);

  // Find low-scoring statements (below minScore or bottom 20%, whichever is more)
  const scoredPairs = scoringStmts.map((stmt, i) => ({
    stmt,
    score: scores[i].qualityScore,
  }));
  scoredPairs.sort((a, b) => a.score - b.score);

  const threshold = Math.max(minScore, 0.4);
  const candidates = scoredPairs
    .filter((p) => p.score < threshold)
    .slice(0, 10); // cap at 10 per pass

  if (candidates.length === 0) {
    return {
      entityId,
      entityType,
      categoriesProcessed: ['quality-rewrite'],
      coverageBefore: scores.length > 0
        ? scores.reduce((s, r) => s + r.qualityScore, 0) / scores.length
        : 0,
      coverageAfter: null,
      created: 0,
      rejected: 0,
      totalCost: tracker.totalCost,
      rejections: [],
    };
  }

  let created = 0;
  let rejected = 0;
  const rejections: PassResult['rejections'] = [];
  const avgScoreBefore = scores.reduce((s, r) => s + r.qualityScore, 0) / scores.length;

  for (const { stmt, score: originalScore } of candidates) {
    if (tracker.totalCost >= budget) break;

    // Find properties for this statement's category
    const category = stmt.property?.category;
    const categoryProps = category
      ? allProperties.filter((p) => p.category === category)
      : allProperties.slice(0, 20);

    const rewrite = await generateRewrite(
      stmt, entityName, entityType, categoryProps, client, tracker,
    );

    if (!rewrite) {
      rejected++;
      rejections.push({
        text: (stmt.statementText ?? '').slice(0, 80),
        reason: 'LLM returned no valid rewrite',
        score: originalScore,
      });
      continue;
    }

    // Quality gate: must score higher than original
    // Exclude the original from siblings for uniqueness check
    const siblingsWithoutOriginal = scoringStmts.filter((s) => s.id !== stmt.id);
    const gate = qualityGateRewrite(
      rewrite, originalScore, entityId, entityName,
      siblingsWithoutOriginal, fullPropertyMap,
    );

    if (!gate.accepted) {
      rejected++;
      rejections.push({
        text: rewrite.statementText.slice(0, 80),
        reason: gate.reason,
        score: gate.newScore,
      });
      continue;
    }

    // Insert new statement, then supersede original (safe ordering)
    if (!dryRun) {
      // Validate propertyId exists in the vocabulary — FK constraint
      const validPropertyId = rewrite.propertyId && fullPropertyMap.has(rewrite.propertyId)
        ? rewrite.propertyId
        : undefined;

      const newStmt: CreateStatementInput = {
        variety: rewrite.variety ?? 'structured',
        statementText: rewrite.statementText,
        subjectEntityId: entityId,
        propertyId: validPropertyId,
        valueText: rewrite.valueText,
        valueNumeric: rewrite.valueNumeric,
        valueUnit: rewrite.valueUnit,
        valueDate: normalizeValueDate(rewrite.valueDate),
        validStart: rewrite.validStart,
        citations: rewrite.citations?.map((c) => ({
          url: c.url,
          sourceQuote: c.sourceQuote,
        })),
      };

      const insertResult = await createStatementBatch([newStmt]);
      if (insertResult.ok) {
        // Only supersede original after successful insert
        await patchStatement(stmt.id, {
          status: 'superseded',
          archiveReason: `Rewritten by quality mode (${originalScore.toFixed(3)} → ${gate.newScore.toFixed(3)})`,
        });
      } else {
        rejected++;
        const errMsg = insertResult.message ?? 'unknown error';
        rejections.push({
          text: rewrite.statementText.slice(0, 80),
          reason: `Insert failed: ${errMsg}`,
          score: gate.newScore,
        });
        continue;
      }
    }

    created++;
  }

  return {
    entityId,
    entityType,
    categoriesProcessed: ['quality-rewrite'],
    coverageBefore: avgScoreBefore,
    coverageAfter: null, // quality mode doesn't re-analyze coverage
    created,
    rejected,
    totalCost: tracker.totalCost,
    rejections,
  };
}

// ---------------------------------------------------------------------------
// Classify mode: assign properties to uncategorized statements
// ---------------------------------------------------------------------------

/**
 * Classify uncategorized statements by assigning appropriate property IDs.
 * Uses LLM to batch-classify statements, then PATCHes the propertyId.
 */
export async function runClassifyPass(opts: ImproveOptions): Promise<PassResult> {
  const { entityId, dryRun, budget, client, tracker } = opts;

  const [stmtsResult, propResult, entityResult] = await Promise.all([
    getStatementsByEntity(entityId),
    getProperties(),
    getEntity(entityId),
  ]);

  const entityName = entityResult.ok
    ? (entityResult.data as { name?: string }).name ?? slugToDisplayName(entityId)
    : slugToDisplayName(entityId);
  const entityType = entityResult.ok
    ? (entityResult.data as { entityType?: string }).entityType ?? 'organization'
    : 'organization';

  if (!stmtsResult.ok) {
    throw new Error(`Failed to fetch statements: ${stmtsResult.message}`);
  }

  const allStatements = [
    ...stmtsResult.data.structured,
    ...stmtsResult.data.attributed,
  ];

  const allProperties = propResult.ok ? propResult.data.properties : [];
  const fullPropertyMap = buildPropertyMap(allProperties);

  // Find uncategorized statements (no propertyId)
  const uncategorized = allStatements.filter(
    (s) => s.status === 'active' && !s.propertyId,
  );

  if (uncategorized.length === 0) {
    return {
      entityId,
      entityType,
      categoriesProcessed: ['classify'],
      coverageBefore: 0,
      coverageAfter: null,
      created: 0,
      rejected: 0,
      totalCost: tracker.totalCost,
      rejections: [],
    };
  }

  // Build property list for the prompt
  const propertyList = allProperties
    .map((p) => `  - ${p.id} (${p.category}): ${p.label}${p.description ? ` — ${p.description}` : ''}`)
    .join('\n');

  // Batch classify in groups of 20
  const batchSize = 20;
  let classified = 0;
  let rejected = 0;
  const rejections: PassResult['rejections'] = [];

  for (let i = 0; i < uncategorized.length; i += batchSize) {
    if (tracker.totalCost >= budget) break;

    const batch = uncategorized.slice(i, i + batchSize);
    const statementsForPrompt = batch
      .map((s, idx) => `  ${idx + 1}. [id=${s.id}] "${(s.statementText ?? '').slice(0, 200)}"`)
      .join('\n');

    const prompt = {
      system: `You are a data classification expert. Assign the most appropriate property ID to each statement from the provided vocabulary. Respond ONLY with a JSON array.`,
      user: `Classify these statements about ${entityName} (${entityType}) by assigning property IDs.

Available properties:
${propertyList}

Statements to classify:
${statementsForPrompt}

Return a JSON array where each element has:
- "id": number — the statement ID
- "propertyId": string — the best-matching property ID from the list above

Choose the most specific matching property. If no property fits well, use null.`,
    };

    const result = await callLlm(client, prompt, {
      model: MODELS.haiku,
      maxTokens: 2000,
      temperature: 0.1,
      retryLabel: 'improve-classify',
      tracker,
      label: `classify-batch-${i}`,
    });

    const parsed = parseJsonFromLlm<Array<{ id: number; propertyId: string | null }>>(
      result.text,
      'improve-classify',
      () => [],
    );

    if (!Array.isArray(parsed)) continue;

    for (const assignment of parsed) {
      if (!assignment || typeof assignment.id !== 'number') continue;
      if (!assignment.propertyId) {
        rejected++;
        rejections.push({
          text: `#${assignment.id}`,
          reason: 'No matching property found',
          score: 0,
        });
        continue;
      }

      // Validate propertyId exists
      if (!fullPropertyMap.has(assignment.propertyId)) {
        rejected++;
        rejections.push({
          text: `#${assignment.id} → ${assignment.propertyId}`,
          reason: 'Property ID not in vocabulary',
          score: 0,
        });
        continue;
      }

      if (!dryRun) {
        const patchResult = await patchStatement(assignment.id, {
          propertyId: assignment.propertyId,
        });
        if (!patchResult.ok) {
          rejected++;
          rejections.push({
            text: `#${assignment.id} → ${assignment.propertyId}`,
            reason: `PATCH failed: ${patchResult.message}`,
            score: 0,
          });
          continue;
        }
      }

      classified++;
    }
  }

  return {
    entityId,
    entityType,
    categoriesProcessed: ['classify'],
    coverageBefore: uncategorized.length,
    coverageAfter: uncategorized.length - classified,
    created: classified,
    rejected,
    totalCost: tracker.totalCost,
    rejections,
  };
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
      throw new Error(`Failed to insert statements: ${batchResult.message}`);
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
// Iterative improvement loop
// ---------------------------------------------------------------------------

/** Function signature for a single improvement pass (injectable for testing). */
export type PassFn = (opts: ImproveOptions) => Promise<PassResult>;

/**
 * Run multiple improvement passes until coverage target is reached, budget is
 * exhausted, max iterations hit, or no progress is made (convergence).
 *
 * Calls `passFn()` (defaults to `runSinglePass`) in a loop, checking
 * `passResult.coverageAfter` against the target after each pass.
 * Reports per-iteration progression.
 */
export async function runIterativeLoop(
  opts: IterativeOptions,
  passFn: PassFn = runSinglePass,
): Promise<IterativeResult> {
  const { targetCoverage, maxIterations, budget, tracker } = opts;
  const passes: PassResult[] = [];
  let finalCoverage = 0;
  let converged = false;
  let stalled = false;

  for (let i = 0; i < maxIterations; i++) {
    // Check budget before starting a new pass
    if (tracker.totalCost >= budget) break;

    const passResult = await passFn(opts);
    passes.push(passResult);

    // Determine the latest coverage value
    const currentCoverage = passResult.coverageAfter ?? passResult.coverageBefore;
    finalCoverage = currentCoverage;

    // Check if target reached
    if (currentCoverage >= targetCoverage) {
      converged = true;
      break;
    }

    // Convergence detection: stop if no statements were created and coverage
    // didn't improve (all gaps filled or all candidates rejected)
    if (passResult.created === 0) {
      stalled = true;
      break;
    }

    // Also stall if coverage didn't improve compared to prior pass
    if (passes.length >= 2) {
      const prevCoverage = passes[passes.length - 2].coverageAfter
        ?? passes[passes.length - 2].coverageBefore;
      if (currentCoverage <= prevCoverage) {
        stalled = true;
        break;
      }
    }
  }

  return {
    passes,
    finalCoverage,
    converged,
    stalled,
    totalCreated: passes.reduce((sum, p) => sum + p.created, 0),
    totalRejected: passes.reduce((sum, p) => sum + p.rejected, 0),
    totalCost: tracker.totalCost,
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

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements improve <entity-id> [options]`);
    console.error(`  Options: --org-type=TYPE --dry-run --category=CAT --no-research --min-score=N --budget=N --json`);
    console.error(`           --target-coverage=N --max-iterations=N --mode=quality|classify`);
    process.exit(1);
  }

  const tracker = new CostTracker();
  const client = createLlmClient();

  const budgetVal = typeof args.budget === 'number'
    ? args.budget
    : typeof args.budget === 'string' ? parseFloat(args.budget) : 5;
  const minScoreVal = typeof args['min-score'] === 'number'
    ? args['min-score']
    : typeof args['min-score'] === 'string' ? parseFloat(args['min-score']) : 0.5;

  const opts: ImproveOptions = {
    entityId,
    orgType: (args['org-type'] as string) ?? null,
    categoryFilter: (args.category as string) ?? null,
    minScore: minScoreVal,
    budget: budgetVal,
    noResearch: args['no-research'] === true,
    dryRun: args['dry-run'] === true,
    client,
    tracker,
  };

  // Parse iterative loop flags
  const targetCoverageRaw = args['target-coverage'];
  const targetCoverage = typeof targetCoverageRaw === 'number'
    ? targetCoverageRaw
    : typeof targetCoverageRaw === 'string' ? parseFloat(targetCoverageRaw) : null;

  const maxIterationsRaw = args['max-iterations'];
  const maxIterations = typeof maxIterationsRaw === 'number'
    ? maxIterationsRaw
    : typeof maxIterationsRaw === 'string' ? parseInt(maxIterationsRaw, 10) : 5;

  // Parse mode flag
  const mode = (args.mode as string) ?? null;

  if (!jsonOutput) console.log(`${c.dim}Analyzing coverage gaps for ${entityId}...${c.reset}`);

  // Dispatch: classify → quality → iterative loop → single pass
  if (mode === 'classify') {
    let result: PassResult;
    try {
      if (!jsonOutput) console.log(`${c.dim}Classify mode: assigning properties to uncategorized statements...${c.reset}`);
      result = await runClassifyPass(opts);
    } catch (err) {
      console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      process.exit(1);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n${c.bold}${c.blue}Classify Summary: ${entityId}${c.reset}`);
      console.log(`  Classified:  ${c.green}${result.created}${c.reset}`);
      console.log(`  Rejected:    ${c.red}${result.rejected}${c.reset}`);
      console.log(`  Remaining:   ${result.coverageAfter ?? '?'} uncategorized`);
      console.log(`  Cost:        $${result.totalCost.toFixed(4)}`);
      if (opts.dryRun) {
        console.log(`  ${c.dim}(dry run — no statements were modified)${c.reset}`);
      }
      if (result.rejections.length > 0) {
        console.log(`\n  ${c.dim}Rejections:${c.reset}`);
        for (const r of result.rejections) {
          console.log(`    ${c.red}✗${c.reset} ${r.text} — ${r.reason}`);
        }
      }
      console.log('');
    }
  } else if (mode === 'quality') {
    let result: PassResult;
    try {
      if (!jsonOutput) console.log(`${c.dim}Quality mode: rewriting low-scoring statements...${c.reset}`);
      result = await runQualityPass(opts);
    } catch (err) {
      console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      process.exit(1);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n${c.bold}${c.blue}Quality Rewrite Summary: ${entityId}${c.reset}`);
      console.log(`  Rewritten:   ${c.green}${result.created}${c.reset}`);
      console.log(`  Rejected:    ${c.red}${result.rejected}${c.reset}`);
      console.log(`  Avg score:   ${result.coverageBefore.toFixed(3)}${result.coverageAfter != null ? ` → ${result.coverageAfter.toFixed(3)}` : ''}`);
      console.log(`  Cost:        $${result.totalCost.toFixed(4)}`);
      if (opts.dryRun) {
        console.log(`  ${c.dim}(dry run — no statements were modified)${c.reset}`);
      }
      if (result.rejections.length > 0) {
        console.log(`\n  ${c.dim}Rejections:${c.reset}`);
        for (const r of result.rejections) {
          console.log(`    ${c.red}✗${c.reset} ${r.text}… — ${r.reason}`);
        }
      }
      console.log('');
    }
  } else if (targetCoverage != null && !isNaN(targetCoverage)) {
    const iterOpts: IterativeOptions = {
      ...opts,
      targetCoverage,
      maxIterations,
    };

    let iterResult: IterativeResult;
    try {
      if (!jsonOutput) {
        console.log(`${c.dim}Target coverage: ${targetCoverage.toFixed(3)}, max iterations: ${maxIterations}${c.reset}`);
      }

      iterResult = await runIterativeLoop({
        ...iterOpts,
        // Wrap runSinglePass progress reporting for non-JSON mode
      });
    } catch (err) {
      console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      process.exit(1);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(iterResult, null, 2));
    } else {
      console.log(`\n${c.bold}${c.blue}Iterative Improvement Summary: ${entityId}${c.reset}`);
      console.log(`  Iterations:  ${iterResult.passes.length}`);
      for (let i = 0; i < iterResult.passes.length; i++) {
        const pass = iterResult.passes[i];
        const coverageAfterStr = pass.coverageAfter != null ? pass.coverageAfter.toFixed(3) : 'N/A';
        const delta = pass.coverageAfter != null
          ? (pass.coverageAfter - pass.coverageBefore)
          : 0;
        const deltaStr = delta > 0 ? `${c.green}+${delta.toFixed(3)}${c.reset}` : delta.toFixed(3);
        console.log(`    Pass ${i + 1}:  coverage ${pass.coverageBefore.toFixed(3)} → ${coverageAfterStr} (${deltaStr}), created ${pass.created}`);
      }
      console.log(`  Created:     ${c.green}${iterResult.totalCreated}${c.reset}`);
      console.log(`  Rejected:    ${c.red}${iterResult.totalRejected}${c.reset}`);
      console.log(`  Coverage:    ${iterResult.passes.length > 0 ? iterResult.passes[0].coverageBefore.toFixed(3) : 'N/A'} → ${iterResult.finalCoverage.toFixed(3)}`);
      console.log(`  Converged:   ${iterResult.converged ? `${c.green}yes${c.reset}` : 'no'}`);
      if (iterResult.stalled) {
        console.log(`  ${c.dim}(stalled — no improvement in last pass)${c.reset}`);
      }
      console.log(`  Cost:        $${iterResult.totalCost.toFixed(4)}`);
      if (opts.dryRun) {
        console.log(`  ${c.dim}(dry run — no statements were inserted)${c.reset}`);
      }
      console.log('');
    }
  } else {
    // Single-pass mode (original behavior)
    let result: PassResult;
    try {
      result = await runSinglePass(opts);
    } catch (err) {
      console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      process.exit(1);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\n${c.bold}${c.blue}Improvement Summary: ${entityId}${c.reset}`);
      console.log(`  Categories:  ${result.categoriesProcessed.join(', ') || '(none — no gaps)'}`);
      console.log(`  Created:     ${c.green}${result.created}${c.reset}`);
      console.log(`  Rejected:    ${c.red}${result.rejected}${c.reset}`);
      console.log(`  Coverage:    ${result.coverageBefore.toFixed(3)}${result.coverageAfter != null ? ` → ${result.coverageAfter.toFixed(3)}` : ''}`);
      console.log(`  Cost:        $${result.totalCost.toFixed(4)}`);
      if (opts.dryRun) {
        console.log(`  ${c.dim}(dry run — no statements were inserted)${c.reset}`);
      }
      console.log('');
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement improvement failed:', err);
    process.exit(1);
  });
}
