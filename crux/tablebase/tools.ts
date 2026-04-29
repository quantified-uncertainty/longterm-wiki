/**
 * TableBase Tools
 *
 * Tool definitions and handlers for the LLM enrichment agent.
 * Tools: web_search (server-side), query_entities, query_existing_records,
 *        submit_records, resolve_entity
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { proposeClaims, getClaimStatus } from '../lib/wiki-server/claims.ts';
import { getVerdictsByEntity } from '../lib/wiki-server/sourcing.ts';
import {
  proposeEnrichment,
  isT1UrlAuthoritative,
  type SupportedRecordType,
} from '../lib/wiki-server/enrichment.ts';
import { suggestResources } from '../lib/search/suggest-resources.ts';
import { generateId } from '../lib/grant-import/id.ts';
import { generateSid, isAnySid, isSid, stripSid, SID_PREFIX } from '../../packages/id-utils/src/index.ts';
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

/**
 * Tables the `--via-propose` path supports in Phase 1 (QUA-655).
 *
 * Only `grants` is wired for now. The endpoint accepts all four types in
 * `SUPPORTED_RECORD_TYPES` (grants, personnel, funding-rounds,
 * benchmark-results), but the loop's enrichment prompts don't all produce
 * records that satisfy the /propose tier gate today — extend this list
 * record-type by record-type as each one proves out. See QUA-655 item 4.
 */
const VIA_PROPOSE_TABLES: ReadonlySet<SupportedRecordType> = new Set(['grants']);

// ---------------------------------------------------------------------------
// Tool definitions (passed to Claude API)
// ---------------------------------------------------------------------------

/** Tool definitions for the enrichment agent. web_search is Anthropic's server tool. */
export function getToolDefinitions(options?: { taskType?: TaskType; apply?: boolean }) {
  const isSourceDiscovery = options?.taskType === 'source-discovery';

  // Source-discovery-specific tools
  const sourceDiscoveryTools = [
    {
      name: 'query_unverifiable_records',
      description: 'Fetch records with unverifiable sourcing verdicts for an entity. Returns the record type, record ID, reasoning why sourcing failed, and current source URL.',
      input_schema: {
        type: 'object',
        properties: {
          entityId: { type: 'string', description: 'Entity ID to query unverifiable records for' },
        },
        required: ['entityId'],
      },
    },
    {
      name: 'suggest_resource',
      description: 'Propose a URL as a resource that could verify one or more records. Registers the URL in the resource database and fetches its content for future sourcing.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to suggest as a source' },
          recordIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Record IDs this source could verify (from query_unverifiable_records)',
          },
          description: { type: 'string', description: 'What information this source contains that is relevant' },
        },
        required: ['url'],
      },
    },
    ...(options?.apply ? [{
      name: 'link_source',
      description: 'Update a record\'s source URL to a better one. Only use this when you are confident the new source actually verifies the record.',
      input_schema: {
        type: 'object',
        properties: {
          recordType: { type: 'string', enum: ['personnel', 'grant', 'funding-round', 'investment', 'benchmark-result'], description: 'Type of the record to update' },
          recordId: { type: 'string', description: 'ID of the record to update' },
          newSourceUrl: { type: 'string', description: 'The new source URL' },
          resourceId: { type: 'string', description: 'Resource ID from suggest_resource (if available)' },
        },
        required: ['recordType', 'recordId', 'newSourceUrl'],
      },
    }] : []),
  ];

  return {
    tools: [
      ...(isSourceDiscovery ? sourceDiscoveryTools : []),
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
              enum: ['personnel', 'grants', 'funding-rounds', 'investments', 'benchmark-results', 'divisions', 'division-personnel', 'funding-programs'],
              description: 'The table to query',
            },
            entityId: { type: 'string', description: 'Entity ID to query records for' },
          },
          required: ['table', 'entityId'],
        },
      },
      {
        name: 'resolve_entity',
        description: 'Resolve an entity name to its stable ID (returned as sid_XXXX). You MUST use this tool to get IDs for people, organizations, benchmarks, etc. before submitting records. Never fabricate IDs — only use the sid_-prefixed values returned by this tool or create_entity.',
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
        description: 'Submit new or updated records to a table. Records are validated and deduplicated before insertion. Entity reference fields (personId, organizationId, etc.) MUST use sid_-prefixed IDs from resolve_entity or create_entity.',
        input_schema: {
          type: 'object',
          properties: {
            table: {
              type: 'string',
              enum: ['personnel', 'grants', 'funding-rounds', 'investments', 'benchmark-results', 'divisions', 'division-personnel', 'funding-programs'],
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
        description: 'Create a new entity (person, organization, benchmark, etc.) in the database. Use this when resolve_entity returns NOT_FOUND for a person or org you need to reference. Returns the new entity\'s stableId as sid_XXXX — use this prefixed value in submit_records.',
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
        description: 'Submit structured claims for async sourcing. Each claim asserts a fact about an entity with a source URL. Claims are verified by a background worker before they can be used to submit records. Returns a batchId for polling via check_claim_status.',
        input_schema: {
          type: 'object',
          properties: {
            targetTable: { type: 'string', enum: ['personnel', 'grants', 'funding-rounds', 'investments', 'benchmark-results', 'divisions', 'division-personnel', 'funding-programs'], description: 'The table these claims will eventually populate' },
            claims: {
              type: 'array',
              description: 'Array of claims to verify. Each must have claimText and sourceUrl.',
              items: {
                type: 'object',
                properties: {
                  claimText: { type: 'string', description: 'The factual assertion (e.g., "Jaime Raldua Veuthey is CEO of Apart Research")' },
                  sourceUrl: { type: 'string', description: 'URL that supports this claim' },
                  resourceId: { type: 'string', description: 'Resource ID (if available)' },
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
        description: 'Check sourcing status of previously submitted claims. Returns per-claim verdicts and aggregate counts.',
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

/**
 * Ensure a stableId has exactly one `sid_` prefix. Idempotent.
 *
 * Stored stableIds in `database.json` are already `sid_`-prefixed, so naive
 * `SID_PREFIX + stableId` concatenation produces `sid_sid_XXX` which the
 * wiki-server's `/sync` validators reject as "reference not found". This
 * helper strips any existing prefix first, so callers can always prepend.
 */
export function ensureSidPrefix(value: string): string {
  return SID_PREFIX + stripSid(value);
}

let _entityMatcher: ReturnType<typeof buildEntityMatcher> | null = null;

function getEntityMatcher() {
  if (!_entityMatcher) {
    _entityMatcher = buildEntityMatcher();
  }
  return _entityMatcher;
}

let _knownStableIds: Set<string> | null = null;

/**
 * Load the set of all known stableIds from database.json.
 * Used to validate that entity references submitted by the LLM actually exist,
 * catching hallucinated 10-char IDs that look like stableIds but don't match anything.
 */
function getKnownStableIds(): Set<string> {
  if (_knownStableIds) return _knownStableIds;
  try {
    const db = JSON.parse(readFileSync(resolve('apps/web/src/data/database.json'), 'utf8'));
    const ids = new Set<string>();
    // Index from byStableId (stableId → slug mapping)
    if (db.idRegistry?.byStableId) {
      for (const sid of Object.keys(db.idRegistry.byStableId)) {
        ids.add(sid);
      }
    }
    // Also index from typedEntities stableId field
    for (const e of db.typedEntities || []) {
      if (e.stableId) ids.add(e.stableId);
    }
    _knownStableIds = ids;
    return ids;
  } catch {
    // If database.json isn't available, return empty set (all stableIds will be rejected)
    _knownStableIds = new Set();
    return _knownStableIds;
  }
}

let _stableIdToSlug: Map<string, string> | null = null;

/**
 * Fields that look like `entityFields` (used in validation) but actually FK
 * into a PG-primary table rather than `entities`. The agent's resolve_entity
 * returns entity stableIds; for these fields we translate sid_ → slug before
 * submission so the server's `IN (slug…)` branch matches.
 *
 * Exported via `__testing__` so tests can assert the mapping without exporting
 * the raw constant.
 */
const NON_ENTITY_REFS_BY_TABLE: Record<string, string[]> = {
  'benchmark-results': ['benchmarkId'],
};

/**
 * Translate entity stableIds into slugs in-place for fields whose FK target
 * is a PG-primary tablebase (e.g. `benchmarks`), not the `entities` table.
 *
 * The agent's `resolve_entity` returns entity stableIds (`sid_XXX`), which
 * the server rejects for non-entity FKs because `benchmarks.id`/`slug` don't
 * look like stableIds. This function is the client-side bridge: it looks up
 * each sid_ value in database.json's `idRegistry.byStableId` (or the
 * typedEntities fallback) and substitutes the entity's slug. The server's
 * existing `slug IN (...)` branch then matches.
 *
 * No-op if the field value is missing, unprefixed, or the stableId isn't in
 * database.json — those cases fall through to existing server-side validation.
 */
function resolveNonEntityForeignKeys(
  table: string,
  records: Array<Record<string, unknown>>,
  stableIdToSlug: Map<string, string>,
): void {
  const fields = NON_ENTITY_REFS_BY_TABLE[table] ?? [];
  if (fields.length === 0) return;
  for (const record of records) {
    for (const field of fields) {
      const val = record[field] as string | undefined;
      if (!val || !isSid(val)) continue;
      const slug = stableIdToSlug.get(val) ?? stableIdToSlug.get(stripSid(val));
      if (slug) record[field] = slug;
    }
  }
}

/**
 * Load a stableId → slug map from database.json, covering both `sid_`-prefixed
 * and bare forms. Used to translate entity stableIds into slugs for table
 * references that target PG-primary tables (e.g. benchmarks) rather than
 * entities — see `resolveNonEntityForeignKeys` above.
 */
function getStableIdToSlugMap(): Map<string, string> {
  if (_stableIdToSlug) return _stableIdToSlug;
  const map = new Map<string, string>();
  try {
    const db = JSON.parse(readFileSync(resolve('apps/web/src/data/database.json'), 'utf8'));
    // idRegistry.byStableId maps stableId → slug directly.
    if (db.idRegistry?.byStableId) {
      for (const [sid, slug] of Object.entries<string>(db.idRegistry.byStableId)) {
        if (typeof slug !== 'string') continue;
        map.set(sid, slug);
        map.set(SID_PREFIX + stripSid(sid), slug);
      }
    }
    // Fall back to typedEntities (slug lives on `id`).
    for (const e of db.typedEntities || []) {
      if (e.stableId && e.id) {
        map.set(e.stableId, e.id);
        map.set(SID_PREFIX + stripSid(e.stableId), e.id);
      }
    }
  } catch {
    // database.json missing — leave map empty; callers fall through to server-side validation.
  }
  _stableIdToSlug = map;
  return map;
}

async function handleQueryEntities(input: Record<string, unknown>): Promise<string> {
  const query = input.query as string;
  const entityType = input.entityType as string | undefined;
  const params = new URLSearchParams({ q: query, limit: '10' });
  if (entityType) params.set('entityType', entityType);

  // typed-client-ok: QUA-770 baseline — tablebase tooling, follow-up migration to typed client tracked
  const result = await apiRequest<{
    results: Array<{ id: string; wikiId?: string; stableId?: string; entityType: string; title: string }>;
  }>('GET', `/api/entities/search?${params.toString()}`);

  if (!result.ok) return `Error: ${result.message}`;
  return JSON.stringify(result.data.results.map(r => ({
    id: r.stableId ? ensureSidPrefix(r.stableId) : r.id,
    slug: r.id,
    title: r.title,
    entityType: r.entityType,
  })));
}

async function handleQueryExistingRecords(input: Record<string, unknown>): Promise<string> {
  const table = input.table as string;
  const entityId = stripSid(input.entityId as string);

  const config = getTableConfig(table);
  if (!config) return `Error: Unknown table "${table}"`;

  // typed-client-ok: QUA-770 baseline — tablebase tooling, follow-up migration to typed client tracked
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
    return JSON.stringify({ found: true, stableId: ensureSidPrefix(match.stableId), slug: match.slug, name: match.name });
  }

  // Try matching with grantee normalization (strips Inc, LLC, etc.)
  const granteeMatch = matchGrantee(name, matcher);
  if (granteeMatch) {
    const m = matcher.match(granteeMatch);
    return JSON.stringify({
      found: true,
      stableId: ensureSidPrefix(granteeMatch),
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
    return JSON.stringify({ created: false, existing: true, stableId: ensureSidPrefix(existing.stableId), name: existing.name });
  }

  // Generate sid_-prefixed stableId (no wikiId — not a full wiki entity)
  const stableId = generateSid();

  // Sync entity to wiki-server (lightweight — no wikiId)
  // typed-client-ok: QUA-770 baseline — tablebase tooling, follow-up migration to typed client tracked
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

  // Update caches so subsequent resolve/validate calls find this entity
  _entityMatcher = null; // Force re-build on next resolve
  // Eagerly initialize the stableId set so newly created entities are recognized
  // by submit_records validation. Without this, batch-creating entities before
  // the first submit_records leaves them missing from the set (it was null).
  getKnownStableIds().add(stableId);
  // Populate stableId → slug directly so resolveNonEntityForeignKeys finds
  // benchmark entities created mid-session (e.g. agent creates a missing
  // benchmark and then submits benchmark-results referencing it). Without
  // this, the sid_→slug translation misses and the server rejects the row.
  // Store both prefixed and bare forms — resolveNonEntityForeignKeys tries
  // lookup(val) then lookup(stripSid(val)).
  const slugMap = getStableIdToSlugMap();
  slugMap.set(ensureSidPrefix(stableId), slug);
  slugMap.set(stripSid(stableId), slug);

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
      estimatedSourcingTime: data.estimatedSourcingTime,
      message: `Submitted ${data.claims.length} claims (${data.jobCount} sourcing jobs created). Use check_claim_status with batchId "${data.batchId}" to poll sourcing progress.`,
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
  skipSourcing: boolean = false,
  viaPropose: boolean = false,
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

  // Reject display name fields that contain sid_-prefixed values
  // (LLM sometimes outputs stableIds as person names)
  const displayNameFields = ['personDisplayName', 'orgDisplayName', 'granteeDisplayName', 'companyDisplayName', 'investorDisplayName', 'holderDisplayName'];
  const badDisplayNames = records.filter(r =>
    displayNameFields.some(f => {
      const val = r[f] as string | undefined;
      return val && val.startsWith('sid_');
    })
  );
  if (badDisplayNames.length > 0) {
    return `Error: ${badDisplayNames.length} record(s) have stableIds in display name fields. Display names must be human-readable, not sid_-prefixed IDs.`;
  }

  // Validate and normalize entity reference fields.
  // resolve_entity and create_entity return sid_-prefixed stableIds. We require
  // the prefix (catches hallucinated IDs) AND verify the underlying ID exists in
  // the known stableId set (catches fabricated sid_XXXX values). Belt + suspenders.
  // See discussion #3387 for the full root cause.
  const entityFields = ['personId', 'organizationId', 'investorId', 'companyId', 'benchmarkId', 'modelId', 'granteeId'];
  const matcher = getEntityMatcher();
  const stableIdSet = getKnownStableIds();
  const invalidRefs: string[] = [];
  for (const record of records) {
    for (const field of entityFields) {
      const val = record[field] as string | undefined;
      if (!val) continue;

      // Skip "new:" prefixed values — these are unresolved names, handled downstream
      if (val.startsWith('new:')) continue;

      // Best path: sid_-prefixed value from resolve_entity / create_entity
      if (isSid(val)) {
        const raw = stripSid(val);
        if (stableIdSet.has(raw) || stableIdSet.has(val)) {
          // Keep the sid_ prefix — entities.stable_id stores the prefixed form,
          // and validateEntityRefs checks against it. Stripping causes lookup misses
          // for newly created entities (see: Arcadia Impact enrichment failure 2026-04-07).
          record[field] = val;
          continue;
        }
        invalidRefs.push(`${field}="${val}" — sid_-prefixed but ID not found in database. Use resolve_entity to get a valid ID.`);
        continue;
      }

      // Try to resolve via entity matcher (handles slugs, names, aliases)
      const match = matcher.match(val);
      if (match) {
        record[field] = match.stableId;
        continue;
      }

      // Legacy bare stableId (10-char alphanumeric) or sid_-prefixed — verify it exists
      if (isAnySid(val)) {
        if (stableIdSet.has(val)) {
          continue;
        }
        invalidRefs.push(`${field}="${val}" — looks like a fabricated stableId. Use resolve_entity to get a sid_-prefixed ID.`);
        continue;
      }

      // Slug-format values that didn't match — leave as-is for server-side resolution
    }
  }

  if (invalidRefs.length > 0) {
    return `Error: ${invalidRefs.length} entity reference(s) could not be verified. These look like fabricated stableIds — use resolve_entity or create_entity to get valid IDs.\n${invalidRefs.join('\n')}`;
  }

  // Translate stableIds to slugs for fields whose target table is NOT `entities`.
  // For example, `benchmark_results.benchmarkId` is a FK to the `benchmarks`
  // PG-primary table (10-char `id` or kebab-case `slug`), not to `entities`.
  // The agent's resolve_entity tool returns `sid_XXX` entity stableIds, which
  // the benchmark-results /sync endpoint rejects. Converting sid_ → slug here
  // means the server's existing `slug IN (...)` branch matches.
  resolveNonEntityForeignKeys(table, records, getStableIdToSlugMap());

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
      if (task.taskType === 'benchmark-source-fill') {
        // Update-only task: agent fills sourceUrl on existing records by id.
        // Running dedup would drop every record (dedup matches on benchmarkId+modelId,
        // which are exactly what the update targets).
        deduped = records;
      } else {
        deduped = await dedupBenchmarkResults(task.entityId, records);
      }
      break;
    case 'grants':
      // Grants are updated (granteeId backfill), not deduped
      deduped = records;
      break;
    case 'divisions':
    case 'division-personnel':
    case 'funding-programs':
      // Field-fill tasks (QUA-24): agent updates existing records by id.
      // Dedup is not meaningful — sync handler upserts with COALESCE.
      deduped = records;
      break;
    default:
      return `Error: Unknown table "${table}"`;
  }

  if (deduped.length === 0) {
    return `All ${records.length} records already exist (deduplication removed them all).`;
  }

  // Source-check gate: check records against their source URLs before submission.
  // Catches hallucinated data (e.g., wrong roles, fabricated affiliations).
  let recordsToSubmit = deduped;
  let sourcingSummary = '';
  if (!skipSourcing && !dryRun) {
    const { verifyBeforeSubmit, formatPreSubmitSummary } = await import('./pre-submit-sourcing.ts');
    const verifyResult = await verifyBeforeSubmit(table, deduped);
    console.log(formatPreSubmitSummary(verifyResult));

    if (verifyResult.rejected.length > 0) {
      sourcingSummary = ` (${verifyResult.rejected.length} rejected by sourcing)`;
    }

    // Combine accepted records and no-source records for submission
    recordsToSubmit = [...verifyResult.accepted, ...verifyResult.noSource];

    if (recordsToSubmit.length === 0) {
      return `All ${deduped.length} records were rejected by sourcing.${verifyResult.rejected.map(r => `\n  - ${r.record.id ?? '?'}: ${r.skipReason}`).join('')}`;
    }
  }

  if (dryRun) {
    return `[DRY RUN] Would submit ${deduped.length} records to ${table} (${records.length - deduped.length} duplicates filtered):\n${JSON.stringify(deduped, null, 2)}`;
  }

  // QUA-655: route supported record types through POST /api/enrichment/propose
  // instead of the direct sync endpoint. Each record is gated server-side by
  // the tier allowlist and written atomically with (row + evidence + verdict).
  if (viaPropose && VIA_PROPOSE_TABLES.has(table as SupportedRecordType)) {
    const dupCount = records.length - deduped.length;
    return submitRecordsViaPropose(
      table as SupportedRecordType,
      recordsToSubmit,
      dupCount,
      sourcingSummary,
    );
  }

  const syncConfig = getTableConfig(table);
  if (!syncConfig) return `Error: Unknown table "${table}"`;

  // Build sync URL with sourcing params
  const syncParams = new URLSearchParams();
  if (syncConfig.requireSourcing) syncParams.set('requireSourcing', 'true');
  if (skipSourcing) {
    syncParams.set('forceSkipSourcing', 'true');
    syncParams.set('reason', 'agent-tool: --skipSourcing flag set by caller');
  }
  const syncQs = syncParams.toString();
  const syncUrl = syncQs ? `${syncConfig.syncPath}?${syncQs}` : syncConfig.syncPath;

  // typed-client-ok: QUA-770 baseline — tablebase tooling, follow-up migration to typed client tracked
  const result = await apiRequest<{ upserted?: number; updated?: number }>(
    syncConfig.syncMethod,
    syncUrl,
    { [syncConfig.syncBodyKey]: recordsToSubmit },
  );

  if (!result.ok) {
    return `Error submitting to ${table}: ${result.message}`;
  }

  const count = result.data.upserted ?? result.data.updated ?? recordsToSubmit.length;
  const dupCount = records.length - deduped.length;
  return `Successfully submitted ${count} records to ${table} (${dupCount} duplicates filtered)${sourcingSummary}.`;
}

/**
 * Submit records one-at-a-time through `POST /api/enrichment/propose`.
 *
 * Each record is classified T1 (URL on the allowlist) or skipped with a
 * clear message. T2/T3 paths require a caller-supplied verdict-LLM output
 * (`quotedText`, `checkerModel`, `reasoning`) which the loop agent does not
 * produce today — those records are deliberately left out of scope for
 * Phase 1 so that a non-T1 source is a signal to the agent, not a silent
 * fall-back to the direct sync path.
 *
 * Returns a human-readable summary for the agent's tool-result channel.
 */
async function submitRecordsViaPropose(
  recordType: SupportedRecordType,
  records: Array<Record<string, unknown>>,
  dupCount: number,
  sourcingSummary: string,
): Promise<string> {
  let acceptedCount = 0;
  const rejected: Array<{ id: string; reason: string }> = [];
  const skippedNonT1: Array<{ id: string; sourceUrl: string }> = [];

  for (const record of records) {
    const recordId = typeof record.id === 'string' ? record.id : '?';
    const sourceUrl =
      (record.source as string | undefined) ??
      (record.sourceUrl as string | undefined);

    if (!sourceUrl) {
      rejected.push({ id: recordId, reason: 'missing source URL' });
      continue;
    }

    // Phase 1: T1-only. Non-T1 sources are surfaced to the agent instead of
    // silently dropping into the direct sync path — the point of the gate is
    // to pressure the agent toward authoritative sources.
    if (!isT1UrlAuthoritative(sourceUrl, recordType)) {
      skippedNonT1.push({ id: recordId, sourceUrl });
      continue;
    }

    // Strip fields the /propose endpoint rejects or manages itself. `sourcing`
    // was attached by pre-submit-sourcing for the legacy path; /propose owns
    // verdict construction.
    const { sourcing: _sourcing, ...rowForPropose } = record;

    const res = await proposeEnrichment({
      tier: 'T1',
      recordType,
      row: rowForPropose,
      sourceUrl,
    });

    if (!res.ok) {
      rejected.push({ id: recordId, reason: `${res.error}: ${res.message}` });
      continue;
    }

    acceptedCount++;
  }

  const lines: string[] = [];
  lines.push(
    `Via /api/enrichment/propose: ${acceptedCount}/${records.length} accepted (${dupCount} duplicates filtered)${sourcingSummary}.`,
  );
  if (skippedNonT1.length > 0) {
    lines.push(
      `  ${skippedNonT1.length} record(s) skipped — source not on T1 authority allowlist (Phase 1 via-propose accepts T1 only):`,
    );
    for (const s of skippedNonT1.slice(0, 5)) {
      lines.push(`    - ${s.id}: ${s.sourceUrl}`);
    }
    if (skippedNonT1.length > 5) {
      lines.push(`    ...and ${skippedNonT1.length - 5} more`);
    }
  }
  if (rejected.length > 0) {
    lines.push(`  ${rejected.length} record(s) rejected by /propose:`);
    for (const r of rejected.slice(0, 5)) {
      lines.push(`    - ${r.id}: ${r.reason}`);
    }
    if (rejected.length > 5) {
      lines.push(`    ...and ${rejected.length - 5} more`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Source-discovery tool handlers
// ---------------------------------------------------------------------------

async function handleQueryUnverifiableRecords(input: Record<string, unknown>): Promise<string> {
  const entityId = input.entityId as string;
  if (!entityId) return 'Error: entityId is required';

  const result = await getVerdictsByEntity(entityId, { verdict: 'unverifiable', limit: 50 });
  if (!result.ok) return `Error fetching unverifiable records: ${result.message}`;

  const { verdicts, total, counts } = result.data;

  const summary = [
    `Entity: ${entityId}`,
    `Total verdicts: confirmed=${counts.confirmed}, unverifiable=${counts.unverifiable}, contradicted=${counts.contradicted}, partial=${counts.partial}`,
    `Showing ${verdicts.length} of ${total} unverifiable records:`,
  ].join('\n');

  const records = verdicts.map((v: Record<string, unknown>) => ({
    recordType: v.recordType,
    recordId: v.recordId,
    displayName: v.displayName,
    reasoning: v.reasoning,
    sourcesChecked: v.sourcesChecked,
  }));

  return `${summary}\n\n${JSON.stringify(records, null, 2)}`;
}

async function handleSuggestResource(
  input: Record<string, unknown>,
  dryRun: boolean,
): Promise<string> {
  const url = input.url as string;
  if (!url) return 'Error: url is required';

  const recordIds = input.recordIds as string[] | undefined;
  const description = input.description as string | undefined;

  if (dryRun) {
    return `[DRY RUN] Would suggest resource: ${url}${recordIds ? ` for records: ${recordIds.join(', ')}` : ''}${description ? ` — ${description}` : ''}`;
  }

  try {
    const result = await suggestResources({ urls: [url] });
    const resource = result.resources[0];
    if (!resource) return `Error: no resource returned for ${url}`;

    return JSON.stringify({
      url: resource.url,
      resourceId: resource.resourceId,
      status: resource.status,
      contentLength: resource.contentLength,
      title: resource.title,
      forRecords: recordIds || [],
      description: description || null,
    }, null, 2);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error suggesting resource: ${msg}`;
  }
}

/** Map sourcing recordType to table-registry table name */
function recordTypeToTable(recordType: string): string {
  switch (recordType) {
    case 'personnel': return 'personnel';
    case 'grant': return 'grants';
    case 'funding-round': return 'funding-rounds';
    case 'investment': return 'investments';
    case 'benchmark-result': return 'benchmark-results';
    default: return recordType;
  }
}

async function handleLinkSource(
  input: Record<string, unknown>,
  dryRun: boolean,
): Promise<string> {
  const recordType = input.recordType as string;
  const recordId = input.recordId as string;
  const newSourceUrl = input.newSourceUrl as string;
  const resourceId = input.resourceId as string | undefined;

  if (!recordType || !recordId || !newSourceUrl) {
    return 'Error: recordType, recordId, and newSourceUrl are required';
  }

  if (dryRun) {
    return `[DRY RUN] Would update ${recordType} record ${recordId} source to: ${newSourceUrl}`;
  }

  // Fetch the existing record to get its full data
  const table = recordTypeToTable(recordType);
  const config = getTableConfig(table);
  if (!config) return `Error: Unknown record type "${recordType}" (table: ${table})`;

  // We need to fetch the specific record — use a search approach
  // The sync endpoints do upserts, so we just need the record ID and the new source
  const updatePayload: Record<string, unknown> = {
    id: recordId,
    source: newSourceUrl,
  };
  if (resourceId) {
    updatePayload.sourceResourceId = resourceId;
  }

  // typed-client-ok: QUA-770 baseline — tablebase tooling, follow-up migration to typed client tracked
  const result = await apiRequest<{ upserted?: number; updated?: number }>(
    config.syncMethod,
    config.syncPath,
    { [config.syncBodyKey]: [updatePayload] },
  );

  if (!result.ok) {
    return `Error updating record: ${result.message}`;
  }

  return `Updated ${recordType} record ${recordId} source to: ${newSourceUrl}${resourceId ? ` (resourceId: ${resourceId})` : ''}`;
}

// ---------------------------------------------------------------------------
// Build tool handlers map for runLlmAgent
// ---------------------------------------------------------------------------

export function buildToolHandlers(
  task: EnrichmentTask,
  dryRun: boolean,
  options: { skipSourcing?: boolean; apply?: boolean; viaPropose?: boolean } = {},
): Record<string, (input: Record<string, unknown>) => Promise<string>> {
  const skipSourcing = options.skipSourcing ?? false;
  const viaPropose = options.viaPropose ?? false;
  const isSourceDiscovery = task.taskType === 'source-discovery';

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<string>> = {
    query_entities: handleQueryEntities,
    query_existing_records: handleQueryExistingRecords,
    resolve_entity: async (input) => handleResolveEntity(input),
    create_entity: async (input) => dryRun
      ? `[DRY RUN] Would create ${input.entityType} entity: "${input.name}"`
      : handleCreateEntity(input),
    submit_records: async (input) => handleSubmitRecords(input, task, dryRun, skipSourcing, viaPropose),
    submit_claims: async (input) => dryRun
      ? `[DRY RUN] Would submit ${(input.claims as unknown[])?.length ?? 0} claims for ${input.targetTable}`
      : handleSubmitClaims(input, task),
    check_claim_status: handleCheckClaimStatus,
  };

  if (isSourceDiscovery) {
    handlers.query_unverifiable_records = handleQueryUnverifiableRecords;
    handlers.suggest_resource = async (input) => handleSuggestResource(input, dryRun);
    if (options.apply) {
      handlers.link_source = async (input) => handleLinkSource(input, dryRun);
    }
  }

  return handlers;
}

/** Get the table API name for a task type */
export function taskTypeToTable(taskType: TaskType): string {
  switch (taskType) {
    case 'grant-grantee-backfill': return 'grants';
    case 'personnel-enrichment': return 'personnel';
    case 'funding-round-research': return 'funding-rounds';
    case 'investment-linking': return 'investments';
    case 'benchmark-result-fill': return 'benchmark-results';
    case 'source-discovery': return 'source_quality';
    case 'division-lead-fill': return 'divisions';
    case 'division-personnel-dates': return 'division-personnel';
    case 'funding-program-enrichment': return 'funding-programs';
    case 'benchmark-source-fill': return 'benchmark-results';
  }
}

// Test-only exports. Not part of the public API.
export const __testing__ = {
  NON_ENTITY_REFS_BY_TABLE,
  resolveNonEntityForeignKeys,
};
