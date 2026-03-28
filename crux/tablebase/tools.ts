/**
 * TableBase Tools
 *
 * Tool definitions and handlers for the LLM enrichment agent.
 * Tools: web_search (server-side), query_entities, query_existing_records,
 *        submit_records, resolve_entity
 */

import { apiRequest } from '../lib/wiki-server/client.ts';
import { proposeClaims, getClaimStatus } from '../lib/wiki-server/claims.ts';
import { generateId } from '../lib/grant-import/id.ts';
import { buildEntityMatcher, matchGrantee } from '../lib/grant-import/entity-matcher.ts';
import { toSlug } from './types.ts';
import { getTableConfig } from './table-registry.ts';
import type { EnrichmentTask, TaskType } from './types.ts';
import {
  dedupPersonnel,
  dedupFundingRounds,
  dedupInvestments,
  dedupBenchmarkResults,
} from './dedup.ts';

// ---------------------------------------------------------------------------
// Tool definitions (passed to Claude API)
// ---------------------------------------------------------------------------

/** Tool definitions for the enrichment agent. web_search is Anthropic's server tool. */
export function getToolDefinitions() {
  return {
    tools: [
      {
        name: 'query_entities',
        description: 'Search for entities in the wiki database. Returns entity IDs, names, and types.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query for entity name or description' },
            entityType: { type: 'string', description: 'Optional entity type filter (e.g., "organization", "person", "ai-model", "benchmark")' },
          },
          required: ['query'],
        },
      },
      {
        name: 'query_existing_records',
        description: 'Fetch existing records for an entity from a specific table. Use this to see what data already exists before adding new records.',
        input_schema: {
          type: 'object',
          properties: {
            table: {
              type: 'string',
              enum: ['personnel', 'grants', 'funding-rounds', 'investments', 'benchmark-results'],
              description: 'The table to query',
            },
            entityId: { type: 'string', description: 'Entity ID to query records for' },
          },
          required: ['table', 'entityId'],
        },
      },
      {
        name: 'resolve_entity',
        description: 'Resolve an entity name to its stable ID. Use this to find entity IDs for people, organizations, benchmarks, etc. before submitting records.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Entity name to resolve (e.g., "OpenAI", "Dario Amodei", "MMLU")' },
          },
          required: ['name'],
        },
      },
      {
        name: 'submit_records',
        description: 'Submit new or updated records to a table. Records are validated and deduplicated before insertion.',
        input_schema: {
          type: 'object',
          properties: {
            table: {
              type: 'string',
              enum: ['personnel', 'grants', 'funding-rounds', 'investments', 'benchmark-results'],
              description: 'The table to write to',
            },
            records: {
              type: 'array',
              description: 'Array of records to submit. Each must include a "source" field with a URL.',
              items: { type: 'object' },
            },
          },
          required: ['table', 'records'],
        },
      },
      {
        name: 'create_entity',
        description: 'Create a new entity (person, organization, benchmark, etc.) in the database. Use this when resolve_entity returns NOT_FOUND for a person or org you need to reference. Returns the new entity\'s stableId.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Full display name (e.g., "Alexander Berger")' },
            entityType: { type: 'string', enum: ['person', 'organization', 'benchmark', 'ai-model'], description: 'Entity type' },
            description: { type: 'string', description: 'Brief one-sentence description' },
          },
          required: ['name', 'entityType'],
        },
      },
      {
        name: 'submit_claims',
        description: 'Submit structured claims for async verification. Each claim asserts a fact about an entity with a source URL. Claims are verified by a background worker before they can be used to submit records. Returns a batchId for polling via check_claim_status.',
        input_schema: {
          type: 'object',
          properties: {
            targetTable: { type: 'string', enum: ['personnel', 'grants', 'funding-rounds', 'investments', 'benchmark-results'], description: 'The table these claims will eventually populate' },
            claims: {
              type: 'array',
              description: 'Array of claims to verify. Each must have claimText and sourceUrl.',
              items: {
                type: 'object',
                properties: {
                  claimText: { type: 'string', description: 'The factual assertion (e.g., "Jaime Raldua Veuthey is CEO of Apart Research")' },
                  sourceUrl: { type: 'string', description: 'URL that supports this claim' },
                  resourceId: { type: 'string', description: 'Resource ID from suggest_resources (if available)' },
                  targetField: { type: 'string', description: 'Which field this claim justifies (e.g., "role", "raised")' },
                  proposedValue: { type: 'string', description: 'The specific value being proposed (e.g., "CEO")' },
                  agentEvidence: { type: 'string', description: 'What you found in the source that supports this claim' },
                },
                required: ['claimText', 'sourceUrl'],
              },
            },
          },
          required: ['targetTable', 'claims'],
        },
      },
      {
        name: 'check_claim_status',
        description: 'Check verification status of previously submitted claims. Returns per-claim verdicts and aggregate counts.',
        input_schema: {
          type: 'object',
          properties: {
            batchId: { type: 'string', description: 'Batch ID for the claim submission to check' },
          },
          required: ['batchId'],
        },
      },
    ],
    // Anthropic server tool for web search — must use the versioned type tag
    serverTools: [
      {
        type: 'web_search_20250305' as const,
        name: 'web_search',
        max_uses: 20,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool handler implementations
// ---------------------------------------------------------------------------

let _entityMatcher: ReturnType<typeof buildEntityMatcher> | null = null;

function getEntityMatcher() {
  if (!_entityMatcher) {
    _entityMatcher = buildEntityMatcher();
  }
  return _entityMatcher;
}

async function handleQueryEntities(input: Record<string, unknown>): Promise<string> {
  const query = input.query as string;
  const entityType = input.entityType as string | undefined;
  const params = new URLSearchParams({ q: query, limit: '10' });
  if (entityType) params.set('entityType', entityType);

  const result = await apiRequest<{
    results: Array<{ id: string; wikiId?: string; stableId?: string; entityType: string; title: string }>;
  }>('GET', `/api/entities/search?${params.toString()}`);

  if (!result.ok) return `Error: ${result.message}`;
  return JSON.stringify(result.data.results.map(r => ({
    id: r.stableId || r.id,
    slug: r.id,
    title: r.title,
    entityType: r.entityType,
  })));
}

async function handleQueryExistingRecords(input: Record<string, unknown>): Promise<string> {
  const table = input.table as string;
  const entityId = input.entityId as string;

  const config = getTableConfig(table);
  if (!config) return `Error: Unknown table "${table}"`;

  const result = await apiRequest<Record<string, unknown>>('GET', `${config.fetchByEntityPath(entityId)}?limit=100`);
  if (!result.ok) return `Error: ${result.message}`;
  const records = result.data[config.resultKey];
  return JSON.stringify(records);
}

function handleResolveEntity(input: Record<string, unknown>): string {
  const name = input.name as string;
  const matcher = getEntityMatcher();

  // Try direct match first
  const match = matcher.match(name);
  if (match) {
    return JSON.stringify({ found: true, stableId: match.stableId, slug: match.slug, name: match.name });
  }

  // Try matching with grantee normalization (strips Inc, LLC, etc.)
  const granteeMatch = matchGrantee(name, matcher);
  if (granteeMatch) {
    const m = matcher.match(granteeMatch);
    return JSON.stringify({
      found: true,
      stableId: granteeMatch,
      slug: m?.slug || '',
      name: m?.name || name,
      matchedVia: 'normalization',
    });
  }

  return JSON.stringify({ found: false, query: name, suggestion: 'Entity not found. Use create_entity to create it, or try alternative names.' });
}

async function handleCreateEntity(input: Record<string, unknown>): Promise<string> {
  const name = input.name as string;
  const entityType = (input.entityType as string) || 'person';
  const description = input.description as string | undefined;

  // Generate slug
  const slug = toSlug(name);

  // Check if already exists
  const matcher = getEntityMatcher();
  const existing = matcher.match(name);
  if (existing) {
    return JSON.stringify({ created: false, existing: true, stableId: existing.stableId, name: existing.name });
  }

  // Generate lightweight stableId (no wikiId — not a full wiki entity)
  const stableId = generateId(`${entityType}:${slug}`);

  // Sync entity to wiki-server (lightweight — no wikiId)
  const syncResult = await apiRequest<{ upserted: number }>('POST', '/api/entities/sync', {
    entities: [{
      id: slug,
      stableId,
      entityType,
      title: name,
      ...(description && { description }),
    }],
  });

  if (!syncResult.ok) {
    return `Error creating entity: ${syncResult.message}`;
  }

  // Update the cached matcher so subsequent resolve calls find this entity
  _entityMatcher = null; // Force re-build on next resolve

  return JSON.stringify({
    created: true,
    stableId,
    slug,
    name,
    entityType,
  });
}

async function handleSubmitClaims(
  input: Record<string, unknown>,
  task: EnrichmentTask,
): Promise<string> {
  const targetTable = input.targetTable as string;
  const claims = input.claims as Array<Record<string, unknown>> | undefined;
  if (!targetTable || !claims || claims.length === 0) {
    return 'Error: targetTable and at least one claim are required';
  }

  try {
    const result = await proposeClaims({
      entityId: task.entityId,
      targetTable,
      claims: claims.map((cl) => ({
        claimText: String(cl.claimText ?? ''),
        sourceUrl: String(cl.sourceUrl ?? ''),
        resourceId: cl.resourceId ? String(cl.resourceId) : undefined,
        targetField: cl.targetField ? String(cl.targetField) : undefined,
        proposedValue: cl.proposedValue ? String(cl.proposedValue) : undefined,
        agentEvidence: cl.agentEvidence ? String(cl.agentEvidence) : undefined,
      })),
    });

    if (!result.ok) return `Error submitting claims: ${result.message}`;

    const data = result.data;
    return JSON.stringify({
      batchId: data.batchId,
      claimCount: data.claims.length,
      jobCount: data.jobCount,
      estimatedVerificationTime: data.estimatedVerificationTime,
      message: `Submitted ${data.claims.length} claims (${data.jobCount} verification jobs created). Use check_claim_status with batchId "${data.batchId}" to poll verification progress.`,
    }, null, 2);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error submitting claims: ${msg}`;
  }
}

async function handleCheckClaimStatus(input: Record<string, unknown>): Promise<string> {
  const batchId = input.batchId as string;
  if (!batchId) return 'Error: batchId is required';

  const result = await getClaimStatus(batchId);
  if (!result.ok) return `Error: ${result.message}`;

  const data = result.data;
  const summary = [
    `Batch ${data.batchId}: ${data.totalClaims} claims`,
    `Status: ${JSON.stringify(data.byStatus)}`,
    `All settled: ${data.allSettled}`,
    ...(data.estimatedRemaining > 0 ? [`Estimated remaining: ${data.estimatedRemaining}s`] : []),
  ].join('\n');

  const MAX_SHOWN = 20;
  const shownClaims = data.claims.slice(0, MAX_SHOWN);
  const omitted = data.claims.length - shownClaims.length;
  const claimsText = JSON.stringify(shownClaims, null, 2);
  const omittedNote = omitted > 0 ? `\n\n...and ${omitted} more claims omitted` : '';

  return `${summary}\n\nClaims:\n${claimsText}${omittedNote}`;
}

async function handleSubmitRecords(
  input: Record<string, unknown>,
  task: EnrichmentTask,
  dryRun: boolean,
): Promise<string> {
  const table = input.table as string;
  const records = input.records as Array<Record<string, unknown>>;

  if (!records || records.length === 0) {
    return 'Error: No records provided';
  }

  // Validate source field
  const missingSource = records.filter(r => !r.source && !r.sourceUrl);
  if (missingSource.length > 0) {
    return `Error: ${missingSource.length} record(s) missing "source" or "sourceUrl" field. Every record must have a source URL.`;
  }

  // Normalize entity reference fields — resolve slugs to stableIds
  // This catches cases where the LLM uses a slug instead of the stableId
  const entityFields = ['personId', 'organizationId', 'investorId', 'companyId', 'benchmarkId', 'modelId', 'granteeId'];
  const matcher = getEntityMatcher();
  for (const record of records) {
    for (const field of entityFields) {
      const val = record[field] as string | undefined;
      if (!val) continue;
      // If it looks like a slug (contains hyphens), try to resolve it to a stableId.
      // StableIds are 10-char alphanumeric (no hyphens), so any value with hyphens is likely a slug.
      if (val.includes('-')) {
        const match = matcher.match(val);
        if (match) {
          record[field] = match.stableId;
        }
      }
    }
  }

  // Generate IDs for new records
  for (const record of records) {
    if (!record.id) {
      const seed = `${table}:${JSON.stringify(record)}:${Date.now()}`;
      record.id = generateId(seed);
    }
  }

  // Dedup against existing records
  let deduped: Array<Record<string, unknown>>;
  switch (table) {
    case 'personnel':
      deduped = await dedupPersonnel(task.entityId, records );
      break;
    case 'funding-rounds':
      deduped = await dedupFundingRounds(task.entityId, records );
      break;
    case 'investments':
      deduped = await dedupInvestments(task.entityId, records );
      break;
    case 'benchmark-results':
      deduped = await dedupBenchmarkResults(task.entityId, records );
      break;
    case 'grants':
      // Grants are updated (granteeId backfill), not deduped
      deduped = records;
      break;
    default:
      return `Error: Unknown table "${table}"`;
  }

  if (deduped.length === 0) {
    return `All ${records.length} records already exist (deduplication removed them all).`;
  }

  if (dryRun) {
    return `[DRY RUN] Would submit ${deduped.length} records to ${table} (${records.length - deduped.length} duplicates filtered):\n${JSON.stringify(deduped, null, 2)}`;
  }

  const syncConfig = getTableConfig(table);
  if (!syncConfig) return `Error: Unknown table "${table}"`;

  const result = await apiRequest<{ upserted?: number; updated?: number }>(
    syncConfig.syncMethod,
    syncConfig.syncPath,
    { [syncConfig.syncBodyKey]: deduped },
  );

  if (!result.ok) {
    return `Error submitting to ${table}: ${result.message}`;
  }

  const count = result.data.upserted ?? result.data.updated ?? deduped.length;
  return `Successfully submitted ${count} records to ${table} (${records.length - deduped.length} duplicates filtered).`;
}

// ---------------------------------------------------------------------------
// Build tool handlers map for runLlmAgent
// ---------------------------------------------------------------------------

export function buildToolHandlers(
  task: EnrichmentTask,
  dryRun: boolean,
): Record<string, (input: Record<string, unknown>) => Promise<string>> {
  return {
    query_entities: handleQueryEntities,
    query_existing_records: handleQueryExistingRecords,
    resolve_entity: async (input) => handleResolveEntity(input),
    create_entity: async (input) => dryRun
      ? `[DRY RUN] Would create ${input.entityType} entity: "${input.name}"`
      : handleCreateEntity(input),
    submit_records: async (input) => handleSubmitRecords(input, task, dryRun),
    submit_claims: async (input) => handleSubmitClaims(input, task),
    check_claim_status: handleCheckClaimStatus,
  };
}

/** Get the table API name for a task type */
export function taskTypeToTable(taskType: TaskType): string {
  switch (taskType) {
    case 'grant-grantee-backfill': return 'grants';
    case 'personnel-enrichment': return 'personnel';
    case 'funding-round-research': return 'funding-rounds';
    case 'investment-linking': return 'investments';
    case 'benchmark-result-fill': return 'benchmark-results';
  }
}
