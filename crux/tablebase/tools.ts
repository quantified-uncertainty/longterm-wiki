/**
 * TableBase Tools
 *
 * Tool definitions and handlers for the LLM enrichment agent.
 * Tools: web_search (server-side), query_entities, query_existing_records,
 *        submit_records, resolve_entity
 */

import { apiRequest } from '../lib/wiki-server/client.ts';
import { generateId } from '../lib/grant-import/id.ts';
import { buildEntityMatcher, matchGrantee } from '../lib/grant-import/entity-matcher.ts';
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
    results: Array<{ id: string; numericId?: string; stableId?: string; entityType: string; title: string }>;
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

  let path: string;
  let resultKey: string;
  switch (table) {
    case 'personnel':
      path = `/api/personnel/by-entity/${encodeURIComponent(entityId)}?limit=100`;
      resultKey = 'personnel';
      break;
    case 'grants':
      path = `/api/grants/by-entity/${encodeURIComponent(entityId)}?limit=100`;
      resultKey = 'grants';
      break;
    case 'funding-rounds':
      path = `/api/funding-rounds/by-entity/${encodeURIComponent(entityId)}?limit=100`;
      resultKey = 'fundingRounds';
      break;
    case 'investments':
      path = `/api/investments/by-entity/${encodeURIComponent(entityId)}?limit=100`;
      resultKey = 'investments';
      break;
    case 'benchmark-results':
      path = `/api/benchmark-results/by-model/${encodeURIComponent(entityId)}?limit=100`;
      resultKey = 'benchmarkResults';
      break;
    default:
      return `Error: Unknown table "${table}"`;
  }

  const result = await apiRequest<Record<string, unknown>>('GET', path);
  if (!result.ok) return `Error: ${result.message}`;
  const records = result.data[resultKey];
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
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  // Check if already exists
  const matcher = getEntityMatcher();
  const existing = matcher.match(name);
  if (existing) {
    return JSON.stringify({ created: false, existing: true, stableId: existing.stableId, name: existing.name });
  }

  // Allocate ID
  const { allocateId } = await import('../lib/wiki-server/ids.ts');
  const idResult = await allocateId(slug, `${entityType}: ${name}`);
  if (!idResult.ok) {
    return `Error allocating ID: ${idResult.message}`;
  }

  // Sync entity
  const syncResult = await apiRequest<{ upserted: number }>('POST', '/api/entities/sync', {
    entities: [{
      id: slug,
      numericId: idResult.data.numericId,
      stableId: idResult.data.stableId,
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
    stableId: idResult.data.stableId,
    numericId: idResult.data.numericId,
    slug,
    name,
    entityType,
  });
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
      deduped = await dedupPersonnel(task.entityId, records as never[]) as unknown as Array<Record<string, unknown>>;
      break;
    case 'funding-rounds':
      deduped = await dedupFundingRounds(task.entityId, records as never[]) as unknown as Array<Record<string, unknown>>;
      break;
    case 'investments':
      deduped = await dedupInvestments(task.entityId, records as never[]) as unknown as Array<Record<string, unknown>>;
      break;
    case 'benchmark-results':
      deduped = await dedupBenchmarkResults(task.entityId, records as never[]) as unknown as Array<Record<string, unknown>>;
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

  // Map table name to API path
  let apiPath: string;
  let bodyKey: string;
  switch (table) {
    case 'personnel':
      apiPath = '/api/personnel/sync';
      bodyKey = 'items';
      break;
    case 'grants':
      apiPath = '/api/grants/batch-update-grantee';
      bodyKey = 'items';
      break;
    case 'funding-rounds':
      apiPath = '/api/funding-rounds/sync';
      bodyKey = 'items';
      break;
    case 'investments':
      apiPath = '/api/investments/sync';
      bodyKey = 'items';
      break;
    case 'benchmark-results':
      apiPath = '/api/benchmark-results/sync';
      bodyKey = 'items';
      break;
    default:
      return `Error: Unknown table "${table}"`;
  }

  // For grant grantee backfill, use PATCH endpoint
  const method = table === 'grants' ? 'PATCH' as const : 'POST' as const;
  const result = await apiRequest<{ upserted?: number; updated?: number }>(
    method,
    apiPath,
    { [bodyKey]: deduped },
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
