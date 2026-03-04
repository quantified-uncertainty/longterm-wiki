/**
 * Statement Improvement Pipeline — generates new statements to fill coverage gaps.
 *
 * Uses the scoring engine (Phase A) to detect gaps, optionally researches via
 * web search, then generates high-quality statements via LLM. Each candidate
 * passes through a quality gate (scoring + uniqueness) before insertion.
 *
 * Usage:
 *   pnpm crux statements improve <entity-id> --org-type=frontier-lab
 *   pnpm crux statements improve <entity-id> --dry-run
 *   pnpm crux statements improve <entity-id> --category=safety
 *   pnpm crux statements improve <entity-id> --no-research --min-score=0.6
 *   pnpm crux statements improve <entity-id> --budget=10 --json
 */

import { fileURLToPath } from 'url';
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
  type CreateStatementInput,
} from '../lib/wiki-server/statements.ts';
import { analyzeGaps, type GapAnalysis } from './gaps.ts';
import {
  scoreStatement,
  scoreUniqueness,
  type ScoringStatement,
  type ScoringContext,
} from './scoring.ts';
import { resolveCoverageTargets } from './coverage-targets.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GeneratedStatement {
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

interface GateResult {
  accepted: CreateStatementInput[];
  rejected: Array<{
    statement: GeneratedStatement;
    reason: string;
    score: number;
  }>;
}

interface ImproveSummary {
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

async function generateStatements(
  entityId: string,
  entityName: string,
  entityType: string,
  category: string,
  deficit: number,
  properties: Array<{ id: string; label: string; description: string | null }>,
  existingTexts: string[],
  sources: string | null,
  client: ReturnType<typeof createLlmClient>,
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

async function runResearchForCategory(
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const jsonOutput = args.json === true;
  const dryRun = args['dry-run'] === true;
  const noResearch = args['no-research'] === true;
  const orgType = (args['org-type'] as string) ?? null;
  const categoryFilter = (args.category as string) ?? null;
  const minScore = typeof args['min-score'] === 'number' ? args['min-score'] : 0.5;
  const budget = typeof args.budget === 'number' ? args.budget : 5;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];

  if (!entityId) {
    console.error(`${c.red}Error: provide an entity ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements improve <entity-id> [options]`);
    console.error(`  Options: --org-type=TYPE --dry-run --category=CAT --no-research --min-score=N --budget=N --json`);
    process.exit(1);
  }

  const tracker = new CostTracker();
  const client = createLlmClient();
  const entityName = slugToDisplayName(entityId);

  // 1. Analyze gaps
  if (!jsonOutput) console.log(`${c.dim}Analyzing coverage gaps for ${entityId}...${c.reset}`);

  let analysis: GapAnalysis;
  try {
    analysis = await analyzeGaps(entityId, orgType);
  } catch (err) {
    console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
    process.exit(1);
  }

  const coverageBefore = analysis.coverageScore;

  // Filter to gaps with deficit > 0
  let targetGaps = analysis.gaps.filter((g) => g.deficit > 0);
  if (categoryFilter) {
    targetGaps = targetGaps.filter((g) => g.category === categoryFilter);
    if (targetGaps.length === 0) {
      if (jsonOutput) {
        console.log(JSON.stringify({ entityId, message: `No deficit for category "${categoryFilter}"` }));
      } else {
        console.log(`${c.green}No deficit for category "${categoryFilter}".${c.reset}`);
      }
      process.exit(0);
    }
  }

  if (targetGaps.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ entityId, message: 'All categories at or above target' }));
    } else {
      console.log(`${c.green}All categories at or above target — nothing to improve.${c.reset}`);
    }
    process.exit(0);
  }

  // Cap to top 5 gaps by priority
  targetGaps = targetGaps.slice(0, 5);

  if (!jsonOutput) {
    console.log(`${c.bold}Targeting ${targetGaps.length} gap categories:${c.reset}`);
    for (const g of targetGaps) {
      console.log(`  ${g.category}: ${g.actual}/${g.target} (deficit: ${g.deficit})`);
    }
    console.log('');
  }

  // 2. Fetch properties for category filtering + quality gate scoring
  const propResult = await getProperties();
  const allProperties = propResult.ok ? propResult.data.properties : [];
  const fullPropertyMap = new Map(
    allProperties.map((p) => [p.id, {
      id: p.id,
      label: p.label,
      category: p.category,
      stalenessCadence: p.stalenessCadence,
    }]),
  );

  // 3. Build existing statement texts per category for dedup
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

  // 4. Process each gap category
  let totalCreated = 0;
  let totalRejected = 0;
  const allRejections: ImproveSummary['rejections'] = [];
  const categoriesProcessed: string[] = [];
  const allAccepted: CreateStatementInput[] = [];

  const budgetPerCategory = budget / targetGaps.length;

  for (const gap of targetGaps) {
    if (tracker.totalCost >= budget) {
      if (!jsonOutput) console.log(`${c.yellow}Budget cap ($${budget}) reached. Stopping.${c.reset}`);
      break;
    }

    categoriesProcessed.push(gap.category);
    if (!jsonOutput) console.log(`${c.blue}Processing: ${gap.category} (deficit: ${gap.deficit})${c.reset}`);

    // Research (optional)
    let sources: string | null = null;
    if (!noResearch) {
      if (!jsonOutput) console.log(`  ${c.dim}Researching...${c.reset}`);
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
    if (!jsonOutput) console.log(`  ${c.dim}Generating ${gap.deficit} statements...${c.reset}`);
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

    if (!jsonOutput) console.log(`  ${c.dim}Generated ${generated.length} candidates${c.reset}`);

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

    if (!jsonOutput) {
      console.log(`  ${c.green}Accepted: ${gateResult.accepted.length}${c.reset}, ${c.red}Rejected: ${gateResult.rejected.length}${c.reset}`);
      for (const r of gateResult.rejected) {
        console.log(`    ${c.dim}✗ ${r.statement.statementText.slice(0, 60)}... — ${r.reason}${c.reset}`);
      }
    }
  }

  // 5. Insert (unless dry-run)
  let coverageAfter: number | null = null;

  if (!dryRun && allAccepted.length > 0) {
    if (!jsonOutput) console.log(`\n${c.dim}Inserting ${allAccepted.length} statements...${c.reset}`);

    const batchResult = await createStatementBatch(allAccepted);
    if (!batchResult.ok) {
      console.error(`${c.red}Failed to insert statements.${c.reset}`);
      process.exit(1);
    }

    // Re-analyze to get updated coverage
    try {
      const updated = await analyzeGaps(entityId, orgType);
      coverageAfter = updated.coverageScore;

      // Store updated coverage score
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

  // 6. Print summary
  const summary: ImproveSummary = {
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

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\n${c.bold}${c.blue}Improvement Summary: ${entityId}${c.reset}`);
    console.log(`  Categories:  ${categoriesProcessed.join(', ')}`);
    console.log(`  Created:     ${c.green}${totalCreated}${c.reset}`);
    console.log(`  Rejected:    ${c.red}${totalRejected}${c.reset}`);
    console.log(`  Coverage:    ${coverageBefore.toFixed(3)}${coverageAfter != null ? ` → ${coverageAfter.toFixed(3)}` : ''}`);
    console.log(`  Cost:        $${tracker.totalCost.toFixed(4)}`);
    if (dryRun) {
      console.log(`  ${c.dim}(dry run — no statements were inserted)${c.reset}`);
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
