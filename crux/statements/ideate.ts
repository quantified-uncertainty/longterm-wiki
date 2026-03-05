/**
 * Entity Ontology Ideation — analyze statements and suggest sub-entity splits.
 *
 * Detects when an entity's statements cluster into distinct subjects that
 * warrant their own entity pages. Can suggest and optionally create sub-entities,
 * reassigning statements to the new entities.
 *
 * Usage:
 *   pnpm crux statements ideate <entity-id>
 *   pnpm crux statements ideate <entity-id> --json
 *   pnpm crux statements ideate <entity-id> --apply
 *   pnpm crux statements ideate <entity-id> --min-cluster=3
 *   pnpm crux statements ideate <entity-id> --budget=2
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import { parseJsonFromLlm } from '../lib/json-parsing.ts';
import {
  getStatementsByEntity,
  getProperties,
  patchStatement,
} from '../lib/wiki-server/statements.ts';
import {
  getEntity,
  syncEntities,
  searchEntities,
  type SyncEntityItem,
} from '../lib/wiki-server/entities.ts';
import { allocateId } from '../lib/wiki-server/ids.ts';
import { slugToDisplayName } from '../lib/claim-text-utils.ts';
import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubEntitySuggestion {
  slug: string;
  title: string;
  entityType: string;
  description: string;
  relationship: string;
  statementIds: number[];
  confidence: number;
  rationale: string;
}

export interface IdeationResult {
  parentEntityId: string;
  parentTitle: string;
  parentEntityType: string;
  totalStatements: number;
  clusters: SubEntitySuggestion[];
  statementsKeptOnParent: number;
  analysis: string;
  cost: number;
}

export interface ApplyResult {
  created: Array<{ slug: string; numericId: string; title: string }>;
  movedStatements: number;
  errors: string[];
}

export interface OntologySuggestion {
  slug: string;
  title: string;
  entityType: string;
  description: string;
  relationship: string;
  priority: 'high' | 'medium' | 'low';
  rationale: string;
  existingStatementIds?: number[];
  estimatedStatementCount: number;
}

export interface OntologyResult {
  parentEntityId: string;
  parentTitle: string;
  parentEntityType: string;
  totalStatements: number;
  existingChildEntities: string[];
  suggestions: OntologySuggestion[];
  missingRelationships: Array<{ from: string; to: string; relationship: string }>;
  taxonomyAssessment: string;
  cost: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STATEMENTS = 150;
const DEFAULT_MIN_CLUSTER = 5;
const DEFAULT_BUDGET = 2;

const ENTITY_TYPE_DESCRIPTIONS: Record<string, string> = {
  project: 'A specific initiative, product, or system (e.g., Claude, GPT-4, AlphaFold)',
  concept: 'An abstract idea, methodology, or framework (e.g., RLHF, Constitutional AI)',
  policy: 'A formal policy, regulation, or governance framework',
  model: 'A specific AI model or model family',
  event: 'A notable event, conference, or incident',
  organization: 'A company, lab, institution, or group',
  person: 'An individual researcher, executive, or public figure',
  approach: 'A technical approach, safety technique, or alignment method',
  risk: 'A specific risk category or threat model',
  'risk-factor': 'A contributing factor to AI risk',
  'safety-agenda': 'A comprehensive safety research agenda or program',
  'case-study': 'A detailed examination of a specific incident or scenario',
  analysis: 'An analytical framework or evaluation methodology',
  debate: 'A contested question or ongoing disagreement in the field',
  resource: 'A paper, report, dataset, or benchmark',
};

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/**
 * Analyze an entity's statements for sub-entity clustering opportunities.
 * Pure analysis — no side effects.
 */
export async function analyzeEntityClusters(
  entityId: string,
  opts: {
    client: Anthropic;
    tracker: CostTracker;
    minCluster?: number;
  },
): Promise<IdeationResult> {
  const minCluster = opts.minCluster ?? DEFAULT_MIN_CLUSTER;

  // Fetch entity + statements + properties in parallel
  const [entityResult, stmtResult, propResult] = await Promise.all([
    getEntity(entityId),
    getStatementsByEntity(entityId),
    getProperties(),
  ]);

  if (!stmtResult.ok) {
    throw new Error(`Could not fetch statements for ${entityId}: ${stmtResult.message}`);
  }

  const parentTitle = entityResult.ok
    ? ((entityResult.data as { name?: string }).name ?? slugToDisplayName(entityId))
    : slugToDisplayName(entityId);
  const parentEntityType = entityResult.ok
    ? ((entityResult.data as { entityType?: string }).entityType ?? 'organization')
    : 'organization';

  // Build property lookup
  const propertyMap = new Map<string, { category: string; label: string }>();
  if (propResult.ok) {
    for (const p of propResult.data.properties) {
      propertyMap.set(p.id, { category: p.category, label: p.label });
    }
  }

  // Merge and deduplicate statements
  const allStatements = [
    ...stmtResult.data.structured,
    ...stmtResult.data.attributed,
  ].filter((s) => s.status === 'active');

  if (allStatements.length === 0) {
    return {
      parentEntityId: entityId,
      parentTitle,
      parentEntityType,
      totalStatements: 0,
      clusters: [],
      statementsKeptOnParent: 0,
      analysis: 'No active statements found for this entity.',
      cost: 0,
    };
  }

  // Truncate if needed
  const truncated = allStatements.length > MAX_STATEMENTS;
  const statementsToAnalyze = truncated
    ? allStatements
        .sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0))
        .slice(0, MAX_STATEMENTS)
    : allStatements;

  if (truncated) {
    console.warn(
      `  Warning: ${allStatements.length} statements exceed limit — analyzing top ${MAX_STATEMENTS} by quality score`,
    );
  }

  // Build existing entities list — related entries + DB search for the parent name
  const existingEntities = new Map<string, string>(); // slug → title
  if (entityResult.ok) {
    const entity = entityResult.data as { relatedEntries?: Array<{ id: string }> };
    if (entity.relatedEntries) {
      for (const re of entity.relatedEntries) {
        existingEntities.set(re.id, re.id);
      }
    }
  }
  // Also search DB for entities whose name contains the parent entity name
  const searchResult = await searchEntities(parentTitle, 50);
  if (searchResult.ok) {
    for (const e of searchResult.data.results) {
      existingEntities.set(e.id, (e as { name?: string }).name ?? e.id);
    }
  }
  const relatedEntities = Array.from(existingEntities.entries()).map(
    ([slug, title]) => `${slug} (${title})`,
  );

  // Build statement list for the prompt
  const statementLines = statementsToAnalyze.map((s) => {
    const prop = s.propertyId ? propertyMap.get(s.propertyId) : null;
    const propLabel = prop ? ` [${prop.category}/${prop.label}]` : '';
    return `- ID:${s.id} | ${s.statementText}${propLabel}`;
  });

  // Build entity type options
  const entityTypeOptions = Object.entries(ENTITY_TYPE_DESCRIPTIONS)
    .map(([type, desc]) => `  - ${type}: ${desc}`)
    .join('\n');

  const systemPrompt = `You are an ontology analyst for an AI safety knowledge base. You analyze statements about entities and identify when distinct sub-topics deserve their own entity pages.

You must return valid JSON with no additional text.`;

  const userPrompt = `Analyze the following ${statementsToAnalyze.length} statements about "${parentTitle}" (${parentEntityType}) and identify clusters that represent distinct sub-topics deserving their own entity pages.

## Entity Context
- Entity: ${parentTitle} (slug: ${entityId}, type: ${parentEntityType})
- Total active statements: ${allStatements.length}${truncated ? ` (showing top ${MAX_STATEMENTS})` : ''}

## Existing Entities in Database (do NOT suggest entities that duplicate or overlap with these)
${relatedEntities.length > 0 ? relatedEntities.map((e) => `- ${e}`).join('\n') : '(none)'}

## Available Entity Types
${entityTypeOptions}

## Statements
${statementLines.join('\n')}

## Instructions

Identify clusters of statements that describe a distinct, recognizable sub-topic (a product, research project, policy, technique, model, event series, etc.) that would benefit from having its own entity page.

**Good split criteria:**
- ${minCluster}+ statements about a clearly distinct subject
- The subject has its own identity separate from the parent (e.g., "Claude" vs "Anthropic")
- Readers would naturally look for information about this subject separately

**Bad split criteria (do NOT suggest):**
- Only 1-${minCluster - 1} statements — not enough to justify a separate entity
- A collection of same-category properties (e.g., "funding history", "financial data", "market metrics") — those are property groupings, not entities. An entity must be a specific *thing* (product, policy, project, technique), not a category of *facts about* the parent
- The entity is just "${parentTitle}'s X" where X is an abstract grouping like "research", "governance", "publications", "commercial activities" — these belong on the parent entity, possibly as sections
- Too vague or abstract (e.g., "AI research" for a lab, "safety work" for a safety org)
- Already exists in the database entities list above (even if listed under a different slug)
- Overlaps significantly with an existing entity (e.g., don't suggest "constitutional-ai" if it already exists)
- Founding stories, company histories, or "how X was created" — these belong on the parent entity page

Be conservative: prefer fewer high-confidence splits over many speculative ones.

Return JSON in this exact format:
{
  "clusters": [
    {
      "slug": "suggested-slug",
      "title": "Human-Readable Title",
      "entityType": "one of the types listed above",
      "description": "1-2 sentence description of what this entity represents",
      "relationship": "relationship label (e.g., product-of, research-of, part-of, policy-of, technique-of)",
      "statementIds": [list of statement IDs that belong to this entity],
      "confidence": 0.0 to 1.0,
      "rationale": "Brief explanation of why this deserves its own entity"
    }
  ],
  "analysis": "Overall assessment: how well-organized is this entity's statement set? Are there clear sub-topics or is everything tightly coupled to the parent?"
}

If no meaningful splits exist, return {"clusters": [], "analysis": "explanation of why"}.`;

  const result = await callLlm(opts.client, { system: systemPrompt, user: userPrompt }, {
    model: MODELS.sonnet,
    maxTokens: 4000,
    temperature: 0.3,
    tracker: opts.tracker,
    label: 'ideate-analysis',
    retryLabel: 'ideate',
  });

  const parsed = parseJsonFromLlm<{ clusters: SubEntitySuggestion[]; analysis: string }>(
    result.text,
    'ideate',
    () => ({ clusters: [], analysis: 'Failed to parse LLM response' }),
  );

  // Filter out low-confidence clusters, those below min cluster size,
  // and those whose slug already exists in the database
  const rawClusters = (parsed.clusters || []).filter(
    (c) => c.statementIds && c.statementIds.length >= minCluster,
  );

  // Post-filter: check each suggested slug against the DB
  const validClusters: SubEntitySuggestion[] = [];
  for (const cluster of rawClusters) {
    if (existingEntities.has(cluster.slug)) {
      console.log(`  Filtered out "${cluster.slug}" — entity already exists in DB`);
      continue;
    }
    // Also check DB directly (slug might not have appeared in search)
    const existing = await getEntity(cluster.slug);
    if (existing.ok) {
      console.log(`  Filtered out "${cluster.slug}" — entity already exists in DB`);
      continue;
    }
    // Validate entity type is a known canonical type
    if (!(cluster.entityType in ENTITY_TYPE_DESCRIPTIONS)) {
      // Try common aliases
      const typeMap: Record<string, string> = {
        product: 'project',
        technique: 'approach',
        method: 'approach',
        paper: 'resource',
        report: 'resource',
        program: 'project',
        initiative: 'project',
        incident: 'case-study',
        framework: 'concept',
      };
      const mapped = typeMap[cluster.entityType];
      if (mapped) {
        cluster.entityType = mapped;
      } else {
        cluster.entityType = 'project'; // safe default
      }
    }
    validClusters.push(cluster);
  }

  // Calculate statements kept on parent
  const movedIds = new Set(validClusters.flatMap((c) => c.statementIds));
  const keptOnParent = allStatements.length - movedIds.size;

  return {
    parentEntityId: entityId,
    parentTitle,
    parentEntityType,
    totalStatements: allStatements.length,
    clusters: validClusters,
    statementsKeptOnParent: keptOnParent,
    analysis: parsed.analysis || '',
    cost: opts.tracker.totalCost,
  };
}

// ---------------------------------------------------------------------------
// Apply ideation results
// ---------------------------------------------------------------------------

/**
 * Execute ideation suggestions: create entities, move statements, update relationships.
 */
export async function applyIdeation(
  result: IdeationResult,
  opts: { dryRun?: boolean },
): Promise<ApplyResult> {
  const created: ApplyResult['created'] = [];
  const errors: string[] = [];
  let movedStatements = 0;

  for (const cluster of result.clusters) {
    // 1. Check if entity already exists
    const existingEntity = await getEntity(cluster.slug);
    if (existingEntity.ok) {
      console.log(`  Skipping "${cluster.slug}" — entity already exists`);
      continue;
    }

    // 2. Allocate ID
    const idResult = await allocateId(cluster.slug, cluster.description);
    if (!idResult.ok) {
      errors.push(`Failed to allocate ID for ${cluster.slug}: ${idResult.message}`);
      continue;
    }

    const numericId = idResult.data.numericId;
    console.log(`  Allocated ${numericId} for ${cluster.slug}`);

    // 3. Create entity via sync
    const entityItem: SyncEntityItem = {
      id: cluster.slug,
      numericId,
      entityType: cluster.entityType,
      title: cluster.title,
      description: cluster.description,
      relatedEntries: [
        {
          id: result.parentEntityId,
          type: result.parentEntityType,
          relationship: reverseRelationship(cluster.relationship),
        },
      ],
    };

    if (!opts.dryRun) {
      const syncResult = await syncEntities([entityItem]);
      if (!syncResult.ok) {
        errors.push(`Failed to sync entity ${cluster.slug}: ${syncResult.message}`);
        continue;
      }
    }

    created.push({ slug: cluster.slug, numericId, title: cluster.title });

    // 4. Move statements
    for (const stmtId of cluster.statementIds) {
      if (opts.dryRun) {
        movedStatements++;
        continue;
      }

      const patchResult = await patchStatement(stmtId, {
        subjectEntityId: cluster.slug,
      });
      if (!patchResult.ok) {
        errors.push(`Failed to move statement ${stmtId} to ${cluster.slug}: ${patchResult.message}`);
      } else {
        movedStatements++;
      }
    }
  }

  // 5. Update parent entity's relatedEntries to include new sub-entities
  if (!opts.dryRun && created.length > 0) {
    const parentEntity = await getEntity(result.parentEntityId);
    if (parentEntity.ok) {
      const existing = (parentEntity.data as { relatedEntries?: Array<{ id: string; type: string; relationship?: string }> }).relatedEntries || [];
      const newEntries = created.map((c) => {
        const cluster = result.clusters.find((cl) => cl.slug === c.slug)!;
        return {
          id: c.slug,
          type: cluster.entityType,
          relationship: cluster.relationship,
        };
      });

      // Merge without duplicates
      const existingIds = new Set(existing.map((e) => e.id));
      const toAdd = newEntries.filter((e) => !existingIds.has(e.id));

      if (toAdd.length > 0) {
        const syncResult = await syncEntities([
          {
            id: result.parentEntityId,
            entityType: result.parentEntityType,
            title: result.parentTitle,
            relatedEntries: [...existing, ...toAdd],
          },
        ]);
        if (!syncResult.ok) {
          errors.push(`Failed to update parent relatedEntries: ${syncResult.message}`);
        }
      }
    }
  }

  return { created, movedStatements, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reverseRelationship(rel: string): string {
  const reverses: Record<string, string> = {
    'product-of': 'has-product',
    'research-of': 'has-research',
    'part-of': 'has-part',
    'policy-of': 'has-policy',
    'technique-of': 'has-technique',
    'model-of': 'has-model',
    'event-of': 'has-event',
  };
  return reverses[rel] ?? `parent-of`;
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const jsonOutput = args.json === true;
  const apply = args.apply === true;
  const minCluster =
    typeof args['min-cluster'] === 'string'
      ? parseInt(args['min-cluster'], 10)
      : typeof args['min-cluster'] === 'number'
        ? args['min-cluster']
        : DEFAULT_MIN_CLUSTER;
  const budget =
    typeof args.budget === 'string'
      ? parseFloat(args.budget)
      : typeof args.budget === 'number'
        ? args.budget
        : DEFAULT_BUDGET;
  const positional = (args._positional as string[]) || [];
  const entityId = positional[0];

  if (!entityId) {
    console.error('Error: provide an entity ID');
    console.error('Usage: pnpm crux statements ideate <entity-id> [--json] [--apply] [--min-cluster=N] [--budget=N]');
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error('Error: wiki-server is not reachable');
    process.exit(1);
  }

  const c = getColors();
  const tracker = new CostTracker();
  const client = createLlmClient();

  if (!jsonOutput) {
    console.log(`\n${c.bold}Ontology Analysis: ${entityId}${c.reset}\n`);
  }

  // Check budget
  if (tracker.totalCost > budget) {
    console.error(`Budget exceeded: $${tracker.totalCost.toFixed(4)} > $${budget}`);
    process.exit(1);
  }

  const result = await analyzeEntityClusters(entityId, {
    client,
    tracker,
    minCluster,
  });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Pretty-print results
    console.log(`  Entity type: ${result.parentEntityType}`);
    console.log(`  Total statements: ${result.totalStatements}`);
    console.log(`  Suggested sub-entities: ${result.clusters.length}`);
    console.log();

    if (result.clusters.length === 0) {
      console.log(`  ${c.dim}No sub-entity splits suggested.${c.reset}`);
    } else {
      for (let i = 0; i < result.clusters.length; i++) {
        const cluster = result.clusters[i];
        console.log(
          `  ${c.bold}${i + 1}. ${cluster.slug}${c.reset} (${cluster.entityType}) — confidence: ${cluster.confidence.toFixed(2)}`,
        );
        console.log(`     "${cluster.description}"`);
        console.log(`     Relationship: ${cluster.relationship} → ${result.parentEntityId}`);
        console.log(`     Statements to move: ${cluster.statementIds.length} (IDs: ${cluster.statementIds.slice(0, 8).join(', ')}${cluster.statementIds.length > 8 ? ', ...' : ''})`);
        console.log(`     Rationale: ${cluster.rationale}`);
        console.log();
      }
    }

    console.log(
      `  Statements staying on ${result.parentEntityId}: ${result.statementsKeptOnParent} / ${result.totalStatements}`,
    );
    console.log();
    console.log(`  ${c.dim}Analysis: ${result.analysis}${c.reset}`);
    console.log(`  Cost: $${tracker.totalCost.toFixed(4)}`);

    if (result.clusters.length > 0 && !apply) {
      console.log(
        `\n  Run with ${c.bold}--apply${c.reset} to create these entities and reassign statements.`,
      );
    }
  }

  // Apply if requested
  if (apply && result.clusters.length > 0) {
    if (!jsonOutput) {
      console.log(`\n${c.bold}Applying ideation results...${c.reset}\n`);
    }

    const applyResult = await applyIdeation(result, { dryRun: false });

    if (jsonOutput) {
      console.log(JSON.stringify(applyResult, null, 2));
    } else {
      if (applyResult.created.length > 0) {
        console.log(`  Created ${applyResult.created.length} entities:`);
        for (const e of applyResult.created) {
          console.log(`    - ${e.numericId} ${e.slug} ("${e.title}")`);
        }
      }
      console.log(`  Moved ${applyResult.movedStatements} statements`);
      if (applyResult.errors.length > 0) {
        console.log(`\n  ${c.bold}Errors:${c.reset}`);
        for (const err of applyResult.errors) {
          console.log(`    - ${err}`);
        }
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Ideate failed:', err);
    process.exit(1);
  });
}
