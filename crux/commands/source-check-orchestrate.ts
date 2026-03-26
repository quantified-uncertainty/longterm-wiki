/**
 * Source-Check Orchestrator
 *
 * Systematically runs source-checks across all TableBase entities, FactBase facts,
 * and structured records. Combines factbase-source-check and records-source-check
 * into a single orchestrated pipeline with prioritization, budget controls, and
 * web search for entities without existing sources.
 *
 * Usage:
 *   crux source-check orchestrate --dry-run                     Preview what would be checked
 *   crux source-check orchestrate --budget=5 --limit=50         Check up to 50 items, $5 budget
 *   crux source-check orchestrate --type=fact                   Check only FactBase facts
 *   crux source-check orchestrate --type=record                 Check only structured records
 *   crux source-check orchestrate --type=entity                 Check entities via web search
 *   crux source-check orchestrate --entity-type=organization    Filter by entity type
 *   crux source-check orchestrate --source=web-search           Include web search for sourceless entities
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { loadDatabase, loadPages, type PageEntry, type Entity } from '../lib/content-types.ts';
import { loadGraphFull } from '../lib/factbase-loader.ts';
import type { LoadedKB } from '../lib/factbase-loader.ts';
import type { Fact, Entity as FBEntity } from '../../packages/factbase/src/types.ts';
import { formatFactValue } from '../../packages/factbase/src/format.ts';
import { createLlmClient } from '../lib/llm.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import type { SourceFetchErrorType } from '../lib/search/paywall-detection.ts';
import {
  VALID_RECORD_TYPES,
  type RecordType,
  type SourceCheckVerdict,
} from '../../apps/wiki-server/src/api-types.ts';
import {
  fetchSourceContent,
  callLlmForSourceCheck,
  storeSourceCheckEvidence,
  storeAggregateVerdict,
  SOURCE_CHECK_CONSTANTS,
  MODELS,
} from '../lib/source-check/index.ts';
import { str, strOrNull, numOrNull, resolveName, extractEntityId } from '../lib/source-check/record-fields.ts';

// ── Constants ────────────────────────────────────────────────────────

const { ESTIMATED_COST_PER_VERIFICATION } = SOURCE_CHECK_CONSTANTS;

/** Entity types ordered by change frequency (most volatile first) */
const ENTITY_TYPE_PRIORITY: string[] = [
  'ai-model',
  'organization',
  'person',
  'project',
  'policy',
  'event',
  'approach',
  'benchmark',
  'concept',
  'risk',
  'analysis',
  'capability',
  'safety-agenda',
  'crux',
  'historical',
];

// ── Types ────────────────────────────────────────────────────────────

interface OrchestrateOptions extends BaseOptions {
  budget?: string;
  limit?: string;
  type?: string;
  'entity-type'?: string;
  entityType?: string;
  source?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  ci?: boolean;
  concurrency?: string;
}

type VerifyItemKind = 'fact' | 'record' | 'entity';

interface VerifyItem {
  kind: VerifyItemKind;
  /** Unique ID for deduplication */
  id: string;
  /** Human-readable description */
  description: string;
  /** Entity type (organization, person, etc.) */
  entityType: string;
  /** Entity name */
  entityName: string;
  /** Priority score (higher = verify first) */
  priority: number;
  /** Source URL if available */
  sourceUrl?: string;
  /** Whether this item has never been verified */
  neverVerified: boolean;
  /** Last verification timestamp (ISO string) if available */
  lastVerifiedAt?: string;
  /**
   * For facts: the fact + entity data.
   * For records: the record data.
   * For entities: the entity data.
   */
  data: FactItemData | RecordItemData | EntityItemData;
}

interface FactItemData {
  kind: 'fact';
  entity: FBEntity;
  fact: Fact;
  propertyName: string;
  formattedValue: string;
}

interface RecordItemData {
  kind: 'record';
  recordType: RecordType;
  recordId: string;
  fields: Record<string, string | number | null>;
  /** Entity ID for the parent entity (org for personnel/divisions, company for funding-rounds, etc.) */
  entityId?: string | null;
}

interface EntityItemData {
  kind: 'entity';
  entity: Entity;
  page?: PageEntry;
}

interface VerifyResult {
  itemId: string;
  kind: VerifyItemKind;
  description: string;
  verdict: SourceCheckVerdict;
  confidence: number;
  extractedValue: string;
  reasoning: string;
  sourceUrl: string;
  errorType?: SourceFetchErrorType;
}

interface VerifyError {
  itemId: string;
  kind: VerifyItemKind;
  description: string;
  error: string;
  errorType?: SourceFetchErrorType;
}

interface OrchestrationSummary {
  total: number;
  confirmed: number;
  contradicted: number;
  unverifiable: number;
  outdated: number;
  partial: number;
  errors: number;
  estimatedCost: number;
  actualVerified: number;
  byKind: Record<VerifyItemKind, { total: number; verified: number }>;
  results: VerifyResult[];
  failures: VerifyError[];
}

// fetchSourceContent is now imported from ../lib/source-check/source-fetcher.ts

// ── Web search for entities without sources ──────────────────────────

/**
 * Perform a simple web search for an entity using Exa API.
 * Falls back gracefully if EXA_API_KEY is not set.
 */
async function searchForEntity(entity: Entity): Promise<string[]> {
  let apiKey: string | undefined;
  try {
    const { getApiKey } = await import('../lib/api-keys.ts');
    apiKey = getApiKey('EXA_API_KEY');
  } catch {
    // api-keys module unavailable
  }

  if (!apiKey) {
    return [];
  }

  const query = `${entity.title} ${entity.type ?? ''}`.trim();

  try {
    const body = {
      query,
      type: 'auto',
      numResults: 3,
      contents: { text: { maxCharacters: 200 } },
    };

    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.warn(`[source-check] Exa search failed: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json() as { results?: Array<{ url: string }> };
    return (data.results ?? []).map(r => r.url).filter(Boolean);
  } catch (e: unknown) {
    console.warn(`[source-check] Web search failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

// ── Wiki-server stats fetching ───────────────────────────────────────

interface VerifiedFactInfo {
  factId: string;
  verdict: string;
  checkedAt?: string;
  needsRecheck?: boolean;
}

interface VerifiedRecordInfo {
  recordType: string;
  recordId: string;
  verdict: string;
  checkedAt?: string;
  needsRecheck?: boolean;
}

/**
 * Fetch existing KB verification verdicts to identify already-verified facts.
 * Returns a Map from factId to verification info.
 */
async function fetchExistingKBVerdicts(): Promise<Map<string, VerifiedFactInfo>> {
  const map = new Map<string, VerifiedFactInfo>();

  try {
    const response = await apiRequest<{
      verdicts: Array<{
        recordType: string;
        recordId: string;
        verdict: string;
        lastComputedAt?: string;
        needsRecheck?: boolean;
      }>;
      total: number;
    }>('GET', '/api/verifications/verdicts?record_type=fact&limit=5000');

    if (response.ok && response.data) {
      for (const v of response.data.verdicts) {
        map.set(v.recordId, {
          factId: v.recordId,
          verdict: v.verdict,
          checkedAt: v.lastComputedAt,
          needsRecheck: v.needsRecheck,
        });
      }
    }
  } catch (e: unknown) {
    console.warn(`[source-check] Could not fetch KB verdicts: ${e instanceof Error ? e.message : String(e)}`);
  }

  return map;
}

/**
 * Fetch existing record verification verdicts.
 * Returns a Map from "recordType:recordId" to verification info.
 */
async function fetchExistingRecordVerdicts(): Promise<Map<string, VerifiedRecordInfo>> {
  const map = new Map<string, VerifiedRecordInfo>();

  try {
    const PAGE_SIZE = 500;
    let offset = 0;

    while (true) {
      const response = await apiRequest<{
        verdicts: Array<{
          recordType: string;
          recordId: string;
          verdict: string;
          lastComputedAt?: string;
          needsRecheck?: boolean;
        }>;
        total: number;
      }>('GET', `/api/verifications/verdicts?limit=${PAGE_SIZE}&offset=${offset}`);

      if (!response.ok || !response.data) break;

      for (const v of response.data.verdicts) {
        map.set(`${v.recordType}:${v.recordId}`, {
          recordType: v.recordType,
          recordId: v.recordId,
          verdict: v.verdict,
          checkedAt: v.lastComputedAt,
          needsRecheck: v.needsRecheck,
        });
      }

      if (response.data.verdicts.length < PAGE_SIZE || map.size >= response.data.total) break;
      offset += PAGE_SIZE;
    }
  } catch (e: unknown) {
    console.warn(`[source-check] Could not fetch record verdicts: ${e instanceof Error ? e.message : String(e)}`);
  }

  return map;
}

// ── Item collection ──────────────────────────────────────────────────

/**
 * Collect FactBase facts as verification items.
 */
function collectFactItems(
  kb: LoadedKB,
  existingVerdicts: Map<string, VerifiedFactInfo>,
  pages: PageEntry[],
  entityTypeFilter?: string,
): VerifyItem[] {
  const items: VerifyItem[] = [];
  const graph = kb.graph;
  const pageByTitle = new Map(pages.map(p => [p.title.toLowerCase(), p]));

  for (const entity of graph.getAllEntities()) {
    if (entityTypeFilter && entity.type !== entityTypeFilter) continue;

    const facts = graph.getFacts(entity.id);
    const page = pageByTitle.get(entity.name.toLowerCase());

    for (const fact of facts) {
      if (!fact.source || fact.id.startsWith('inv_')) continue;

      const property = graph.getProperty(fact.propertyId);
      const formattedValue = formatFactValue(fact, property, graph);
      const existing = existingVerdicts.get(fact.id);

      const priority = computeFactPriority(entity, fact, existing, page);

      items.push({
        kind: 'fact',
        id: `fact:${fact.id}`,
        description: `${entity.name} / ${property?.name ?? fact.propertyId} = ${formattedValue}`,
        entityType: entity.type ?? 'unknown',
        entityName: entity.name,
        priority,
        sourceUrl: fact.source,
        neverVerified: !existing,
        lastVerifiedAt: existing?.checkedAt,
        data: {
          kind: 'fact',
          entity,
          fact,
          propertyName: property?.name ?? fact.propertyId,
          formattedValue,
        },
      });
    }
  }

  return items;
}

/**
 * Collect structured records as verification items.
 */
async function collectRecordItems(
  existingVerdicts: Map<string, VerifiedRecordInfo>,
  entityTypeFilter?: string,
): Promise<VerifyItem[]> {
  const items: VerifyItem[] = [];

  // Determine which record types to scan
  const typesToScan = entityTypeFilter
    ? VALID_RECORD_TYPES.filter(t => t === entityTypeFilter)
    : [...VALID_RECORD_TYPES];

  for (const recordType of typesToScan) {
    let apiPath: string;
    switch (recordType) {
      case 'grant': apiPath = '/api/grants/all'; break;
      case 'personnel': apiPath = '/api/personnel/all'; break;
      case 'division': apiPath = '/api/divisions/all'; break;
      case 'funding-program': apiPath = '/api/funding-programs/all'; break;
      case 'funding-round': apiPath = '/api/funding-rounds/all'; break;
      case 'investment': apiPath = '/api/investments/all'; break;
      case 'equity-position': apiPath = '/api/equity-positions/all'; break;
      case 'policy-stakeholder': apiPath = '/api/policy-stakeholders/all'; break;
      case 'publication': apiPath = '/api/publications/all'; break;
      case 'benchmark-result': apiPath = '/api/benchmark-results/all'; break;
      case 'entity-event': apiPath = '/api/entity-events/all'; break;
      case 'entity-assessment': apiPath = '/api/entity-assessments/all'; break;
      case 'secondary-market-price': apiPath = '/api/secondary-market-prices/all'; break;
      default: continue; // Skip unknown record types
    }

    try {
      const response = await apiRequest<Record<string, unknown>>('GET', apiPath);
      if (!response.ok) {
        console.warn(`[source-check] Failed to fetch ${recordType}: ${response.message}`);
        continue;
      }

      // Extract items array from the response (API uses different keys)
      const data = response.data;
      const rawItems = (
        data.items ?? data.grants ?? data.personnel ?? data.divisions ??
        data.programs ?? data.rounds ?? data.investments ?? data.positions ??
        data.publications ?? data.benchmarkResults ?? data.events ??
        data.assessments ?? data.prices ??
        (Array.isArray(data) ? data : [])
      ) as Record<string, unknown>[];

      for (const item of rawItems) {
        // Some record types use 'sourceUrl' instead of 'source' (e.g. benchmark-result)
        const source = item.source ?? item.sourceUrl;
        if (typeof source !== 'string' || !source) continue;

        const id = String(item.id ?? '');
        const key = `${recordType}:${id}`;
        const existing = existingVerdicts.get(key);

        const description = buildRecordDescription(recordType, item);
        const fields = extractRecordFields(recordType, item);

        const priority = computeRecordPriority(recordType, existing);

        const entityId = extractEntityId(recordType, item);

        items.push({
          kind: 'record',
          id: `record:${recordType}:${id}`,
          description,
          entityType: recordType,
          entityName: description,
          priority,
          sourceUrl: source,
          neverVerified: !existing,
          lastVerifiedAt: existing?.checkedAt,
          data: {
            kind: 'record',
            recordType,
            recordId: id,
            fields,
            entityId,
          },
        });
      }
    } catch (e: unknown) {
      console.warn(`[source-check] Error collecting ${recordType}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return items;
}

/**
 * Collect entities for web-search-based verification (entities without sources).
 */
function collectEntityItems(
  entities: Entity[],
  pages: PageEntry[],
  entityTypeFilter?: string,
): VerifyItem[] {
  const items: VerifyItem[] = [];
  const pageByEntityId = new Map<string, PageEntry>();

  for (const page of pages) {
    // Match pages to entities by looking for entity IDs in their path or frontmatter
    if (page.id) {
      pageByEntityId.set(page.id, page);
    }
  }

  for (const entity of entities) {
    if (entityTypeFilter && entity.type !== entityTypeFilter) continue;

    // Only include entities that lack source URLs (candidates for web search)
    const hasSources = entity.sources && entity.sources.length > 0;
    if (hasSources) continue;

    const page = pageByEntityId.get(entity.id);
    const entityTypePriorityIndex = ENTITY_TYPE_PRIORITY.indexOf(entity.type ?? '');
    const typePriority = entityTypePriorityIndex >= 0
      ? (ENTITY_TYPE_PRIORITY.length - entityTypePriorityIndex) * 10
      : 0;

    const readerImportance = page?.readerImportance ?? 0;
    const priority = typePriority + (readerImportance * 5);

    items.push({
      kind: 'entity',
      id: `entity:${entity.id}`,
      description: `${entity.title} (${entity.type ?? 'unknown'})`,
      entityType: entity.type ?? 'unknown',
      entityName: entity.title,
      priority,
      neverVerified: true,
      data: {
        kind: 'entity',
        entity,
        page,
      },
    });
  }

  return items;
}

// ── Priority computation ─────────────────────────────────────────────

function computeFactPriority(
  entity: FBEntity,
  _fact: Fact,
  existing: VerifiedFactInfo | undefined,
  page: PageEntry | undefined,
): number {
  let priority = 0;

  // Never-verified items get highest priority
  if (!existing) {
    priority += 100;
  } else if (existing.needsRecheck) {
    priority += 80;
  } else {
    // Staleness: older verifications get higher priority
    if (existing.checkedAt) {
      const ageMs = Date.now() - new Date(existing.checkedAt).getTime();
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      priority += Math.min(50, ageDays / 7); // +1 per week, max 50
    }
  }

  // Entity type priority
  const entityTypePriorityIndex = ENTITY_TYPE_PRIORITY.indexOf(entity.type ?? '');
  if (entityTypePriorityIndex >= 0) {
    priority += (ENTITY_TYPE_PRIORITY.length - entityTypePriorityIndex) * 3;
  }

  // Reader importance from page data
  if (page?.readerImportance) {
    priority += page.readerImportance * 5;
  }

  return priority;
}

function computeRecordPriority(
  recordType: RecordType,
  existing: VerifiedRecordInfo | undefined,
): number {
  let priority = 0;

  if (!existing) {
    priority += 100;
  } else if (existing.needsRecheck) {
    priority += 80;
  } else if (existing.checkedAt) {
    const ageMs = Date.now() - new Date(existing.checkedAt).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    priority += Math.min(50, ageDays / 7);
  }

  // Some record types are more important to verify
  const recordTypePriority: Record<string, number> = {
    'grant': 30,
    'personnel': 25,
    'funding-round': 20,
    'investment': 20,
    'publication': 18,
    'secondary-market-price': 18,
    'benchmark-result': 15,
    'division': 15,
    'funding-program': 15,
    'entity-event': 12,
    'entity-assessment': 10,
    'equity-position': 10,
    'policy-stakeholder': 10,
  };
  priority += recordTypePriority[recordType] ?? 0;

  return priority;
}

// ── Record description/field extraction ──────────────────────────────

// str, strOrNull, numOrNull, resolveName imported from ../lib/source-check/record-fields.ts

function buildRecordDescription(recordType: RecordType, item: Record<string, unknown>): string {
  switch (recordType) {
    case 'grant': {
      const funder = resolveName(item, 'orgResolvedName', 'orgDisplayName', 'organizationId');
      const grantee = resolveName(item, 'granteeResolvedName', 'granteeDisplayName', 'granteeId');
      return `Grant: ${str(item, 'name')} (${funder} -> ${grantee})`;
    }
    case 'personnel': {
      const person = resolveName(item, 'personResolvedName', 'personDisplayName', 'personId');
      const org = resolveName(item, 'orgResolvedName', 'orgDisplayName', 'organizationId');
      return `Personnel: ${person} at ${org} (${str(item, 'role')})`;
    }
    case 'division':
      return `Division: ${str(item, 'name')}`;
    case 'funding-program':
      return `Funding Program: ${str(item, 'name')}`;
    case 'funding-round': {
      const company = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
      return `Funding Round: ${str(item, 'name')} (${company})`;
    }
    case 'investment': {
      const investor = resolveName(item, 'investorResolvedName', 'investorDisplayName', 'investorId');
      const company = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
      return `Investment: ${investor} -> ${company}`;
    }
    case 'equity-position': {
      const holder = resolveName(item, 'holderResolvedName', 'holderDisplayName', 'holderId');
      const company = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
      return `Equity: ${holder} in ${company}`;
    }
    case 'policy-stakeholder': {
      const name = resolveName(item, 'stakeholderResolvedName', 'stakeholderDisplayName', 'stakeholderId');
      return `Stakeholder: ${name} (${strOrNull(item, 'stance') ?? 'unknown'})`;
    }
    case 'publication': {
      const title = str(item, 'title');
      const authors = strOrNull(item, 'authors') ?? 'unknown authors';
      const year = strOrNull(item, 'publishedDate') ?? 'unknown year';
      return `Publication: ${title} by ${authors} (${year})`;
    }
    case 'benchmark-result': {
      const benchmarkId = str(item, 'benchmarkId');
      const modelId = str(item, 'modelId');
      const score = numOrNull(item, 'score');
      return `Benchmark Result: ${modelId} on ${benchmarkId} = ${score ?? 'N/A'}`;
    }
    case 'entity-event': {
      const title = str(item, 'title');
      const eventType = strOrNull(item, 'eventType') ?? 'unknown';
      const date = strOrNull(item, 'date') ?? 'unknown date';
      return `Entity Event: ${title} (${eventType}, ${date})`;
    }
    case 'entity-assessment': {
      const dimension = str(item, 'dimension');
      const rating = str(item, 'rating');
      const entityId = strOrNull(item, 'entityId') ?? 'unknown';
      return `Assessment: ${entityId} / ${dimension} = ${rating}`;
    }
    case 'secondary-market-price': {
      const company = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
      const platform = str(item, 'platform');
      const date = strOrNull(item, 'date') ?? 'unknown date';
      const valuation = numOrNull(item, 'impliedValuation');
      const valuationStr = valuation != null ? ` ($${(valuation / 1e9).toFixed(1)}B)` : '';
      return `Market Price: ${company} on ${platform} (${date})${valuationStr}`;
    }
  }
}

function extractRecordFields(recordType: RecordType, item: Record<string, unknown>): Record<string, string | number | null> {
  switch (recordType) {
    case 'grant':
      return {
        name: str(item, 'name'),
        amount: numOrNull(item, 'amount'),
        date: strOrNull(item, 'date'),
        grantee: resolveName(item, 'granteeResolvedName', 'granteeDisplayName', 'granteeId'),
        funder: resolveName(item, 'orgResolvedName', 'orgDisplayName', 'organizationId'),
      };
    case 'personnel':
      return {
        person: resolveName(item, 'personResolvedName', 'personDisplayName', 'personId'),
        org: resolveName(item, 'orgResolvedName', 'orgDisplayName', 'organizationId'),
        role: str(item, 'role'),
        startDate: strOrNull(item, 'startDate'),
        endDate: strOrNull(item, 'endDate'),
      };
    case 'division':
      return { name: str(item, 'name'), type: str(item, 'divisionType'), status: str(item, 'status') };
    case 'funding-program':
      return { name: str(item, 'name'), budget: numOrNull(item, 'totalBudget'), status: strOrNull(item, 'status') };
    case 'funding-round':
      return { name: str(item, 'name'), raised: numOrNull(item, 'raised'), valuation: numOrNull(item, 'valuation'), date: strOrNull(item, 'date') };
    case 'investment':
      return { amount: numOrNull(item, 'amount'), round: strOrNull(item, 'roundName'), role: strOrNull(item, 'role') };
    case 'equity-position':
      return { stake: strOrNull(item, 'stake'), asOf: strOrNull(item, 'asOf') };
    case 'policy-stakeholder':
      return { stance: strOrNull(item, 'stance'), role: strOrNull(item, 'role') };
    case 'publication':
      return {
        title: str(item, 'title'),
        authors: strOrNull(item, 'authors'),
        publishedDate: strOrNull(item, 'publishedDate'),
        url: strOrNull(item, 'url'),
        venue: strOrNull(item, 'venue'),
        publicationType: strOrNull(item, 'publicationType'),
      };
    case 'benchmark-result':
      return {
        benchmarkId: str(item, 'benchmarkId'),
        modelId: str(item, 'modelId'),
        score: numOrNull(item, 'score'),
        unit: strOrNull(item, 'unit'),
        date: strOrNull(item, 'date'),
      };
    case 'entity-event':
      return {
        title: str(item, 'title'),
        eventType: str(item, 'eventType'),
        date: strOrNull(item, 'date'),
        entityId: strOrNull(item, 'entityId'),
        significance: strOrNull(item, 'significance'),
      };
    case 'entity-assessment':
      return {
        entityId: strOrNull(item, 'entityId'),
        dimension: str(item, 'dimension'),
        rating: str(item, 'rating'),
        assessor: strOrNull(item, 'assessor'),
        assessedAt: strOrNull(item, 'assessedAt'),
      };
    case 'secondary-market-price':
      return {
        company: resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId'),
        platform: str(item, 'platform'),
        date: strOrNull(item, 'date'),
        impliedValuation: numOrNull(item, 'impliedValuation'),
        pricePerShare: numOrNull(item, 'pricePerShare'),
        priceType: strOrNull(item, 'priceType'),
      };
  }
}

// ── LLM verification ─────────────────────────────────────────────────

function buildFactVerificationPrompt(
  data: FactItemData,
  sourceText: string,
): string {
  const asOfStr = data.fact.asOf ? ` (as of ${data.fact.asOf})` : '';
  const notesStr = data.fact.notes ? `\nAdditional context: ${data.fact.notes}` : '';

  return `You are a fact-checker. Given the source text below, verify this claim.

Claim: ${data.entity.name}'s ${data.propertyName} = ${data.formattedValue}${asOfStr}${notesStr}

Source URL: ${data.fact.source}

Source text (excerpt):
---
${sourceText.slice(0, 4000)}
---

Does the source text confirm, contradict, or not address this claim?

IMPORTANT — avoid these common false-positive errors:
- **Range vs. point**: If the source gives a range (e.g., "51-200 employees") and the claimed value falls within that range (e.g., 91), that is "confirmed", NOT contradicted.
- **Temporal mismatch**: Only compare values from the same time period. If the claim is "as of 2024" but the source discusses 2025 projections (or vice versa), that is "unverifiable" or "outdated", NOT contradicted.
- **Wrong source relevance**: The source must actually discuss the specific claim. If the source is about entity X's own page but the claim is about a person's prior employment at entity Y, the source cannot contradict that — it's "unverifiable".
- **Approximate values**: A claimed value within 10% of the source value is "partial" or "confirmed", not "contradicted". Only use "contradicted" when values clearly conflict (e.g., source says 500, claim says 2000).

Other considerations:
- Numbers may be expressed differently (e.g., "1 billion" vs "1e9" vs "$1B")
- Dates may be approximate
- If the source discusses the topic but the specific data point isn't mentioned, that's "unverifiable"
- If the source has a newer value that supersedes the claimed value, that's "outdated"
- If the source partially confirms (e.g., confirms the ballpark but not the exact figure), that's "partial"

Reserve "contradicted" ONLY for cases where the source clearly and directly states a value that is incompatible with the claim for the same time period.

Respond with ONLY a JSON object (no markdown code fences):
{
  "verdict": "confirmed|contradicted|unverifiable|outdated|partial",
  "confidence": 0.0 to 1.0,
  "extracted_value": "What the source actually says about this data point (quote or paraphrase)",
  "reasoning": "Brief explanation of your verdict"
}`;
}

function buildRecordVerificationPrompt(
  data: RecordItemData,
  description: string,
  sourceText: string,
): string {
  const fieldsStr = Object.entries(data.fields)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  return `You are a fact-checker. Given the source text below, verify this structured data record.

Record type: ${data.recordType}
Record: ${description}
Key fields:
${fieldsStr}

Source text (excerpt):
---
${sourceText.slice(0, 4000)}
---

Does the source text confirm, contradict, or not address the claims in this record?

IMPORTANT — avoid these common false-positive errors:
- **Range vs. point**: If the source gives a range (e.g., "51-200 employees") and the claimed value falls within that range (e.g., 91), that is "confirmed", NOT contradicted.
- **Temporal mismatch**: Only compare values from the same time period. If the claim is about 2024 but the source discusses 2025 (or vice versa), that is "unverifiable" or "outdated", NOT contradicted.
- **Wrong source relevance**: The source must actually discuss the specific claim. A company's own page cannot contradict a person's prior employment at a different company — that's "unverifiable".
- **Approximate values**: A claimed value within 10% of the source value is "partial" or "confirmed", not "contradicted".

Other considerations:
- Numbers may be expressed differently (e.g., "1 billion" vs "1e9" vs "$1B")
- Names may differ slightly (abbreviations, legal names vs common names)
- Dates may be approximate
- If the source discusses the topic but doesn't contain the specific data, that's "unverifiable"
- If the source has newer data that supersedes the record, that's "outdated"
- If the source partially confirms (e.g., confirms role but not dates), that's "partial"

Reserve "contradicted" ONLY for cases where the source clearly and directly states a value that is incompatible with the claim for the same time period.

Respond with ONLY a JSON object (no markdown code fences):
{
  "verdict": "confirmed|contradicted|unverifiable|outdated|partial",
  "confidence": 0.0 to 1.0,
  "extracted_value": "What the source actually says about this record (quote or paraphrase)",
  "reasoning": "Brief explanation of your verdict"
}`;
}

function buildEntityVerificationPrompt(
  entity: Entity,
  sourceText: string,
  sourceUrl: string,
): string {
  const fieldsToCheck: string[] = [];
  if (entity.description) fieldsToCheck.push(`Description: ${entity.description}`);
  if (entity.status) fieldsToCheck.push(`Status: ${entity.status}`);
  if (entity.type) fieldsToCheck.push(`Type: ${entity.type}`);

  return `You are a fact-checker. Given the source text below, verify information about this entity.

Entity: ${entity.title} (${entity.type ?? 'unknown'})
${fieldsToCheck.length > 0 ? `Known attributes:\n${fieldsToCheck.join('\n')}` : 'No specific attributes to verify.'}

Source URL: ${sourceUrl}

Source text (excerpt):
---
${sourceText.slice(0, 4000)}
---

Does the source text contain information about this entity? If so, does it confirm or contradict what we know?

Respond with ONLY a JSON object (no markdown code fences):
{
  "verdict": "confirmed|contradicted|unverifiable|outdated|partial",
  "confidence": 0.0 to 1.0,
  "extracted_value": "Key facts the source mentions about this entity",
  "reasoning": "Brief explanation of your verdict"
}`;
}

async function verifySingleItem(
  item: VerifyItem,
  client: ReturnType<typeof createLlmClient>,
  useWebSearch: boolean,
): Promise<VerifyResult | VerifyError> {
  let sourceUrl = item.sourceUrl;
  let sourceContent: string | null = null;

  if (item.data.kind === 'entity' && !sourceUrl) {
    // Web search for entities without sources
    if (!useWebSearch) {
      return {
        itemId: item.id,
        kind: item.kind,
        description: item.description,
        error: 'No source URL and web search not enabled (use --source=web-search)',
      };
    }

    const urls = await searchForEntity(item.data.entity);
    if (urls.length === 0) {
      return {
        itemId: item.id,
        kind: item.kind,
        description: item.description,
        error: 'No sources found via web search',
      };
    }

    // Try each URL until we get content
    for (const url of urls) {
      const result = await fetchSourceContent(url);
      if (result.content) {
        sourceUrl = url;
        sourceContent = result.content;
        break;
      }
    }

    if (!sourceContent || !sourceUrl) {
      return {
        itemId: item.id,
        kind: item.kind,
        description: item.description,
        error: 'Web search found URLs but could not fetch content',
      };
    }
  } else if (sourceUrl) {
    const fetchResult = await fetchSourceContent(sourceUrl);
    if (!fetchResult.content) {
      return {
        itemId: item.id,
        kind: item.kind,
        description: item.description,
        error: fetchResult.errorMessage ?? 'Could not fetch source content',
        errorType: fetchResult.errorType,
      };
    }
    sourceContent = fetchResult.content;
  } else {
    return {
      itemId: item.id,
      kind: item.kind,
      description: item.description,
      error: 'No source URL available',
    };
  }

  // At this point, sourceUrl and sourceContent are guaranteed to be defined
  // (all paths without them return early above)
  const verifiedSourceUrl: string = sourceUrl!;

  // Build the appropriate prompt
  let prompt: string;
  switch (item.data.kind) {
    case 'fact':
      prompt = buildFactVerificationPrompt(item.data, sourceContent);
      break;
    case 'record':
      prompt = buildRecordVerificationPrompt(item.data, item.description, sourceContent);
      break;
    case 'entity':
      prompt = buildEntityVerificationPrompt(item.data.entity, sourceContent, verifiedSourceUrl);
      break;
  }

  try {
    const llmResult = await callLlmForSourceCheck(client, prompt, `verify-${item.id}`);

    return {
      itemId: item.id,
      kind: item.kind,
      description: item.description,
      verdict: llmResult.verdict as SourceCheckVerdict,
      confidence: llmResult.confidence,
      extractedValue: llmResult.extractedValue,
      reasoning: llmResult.reasoning,
      sourceUrl: verifiedSourceUrl,
    };
  } catch (e: unknown) {
    return {
      itemId: item.id,
      kind: item.kind,
      description: item.description,
      error: `LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Result storage ───────────────────────────────────────────────────

async function storeResult(item: VerifyItem, result: VerifyResult): Promise<void> {
  if (item.data.kind === 'fact') {
    const factId = (item.data as FactItemData).fact.id;

    await storeSourceCheckEvidence({
      recordType: 'fact',
      recordId: factId,
      sourceUrl: result.sourceUrl,
      verdict: result.verdict,
      confidence: result.confidence,
      extractedValue: result.extractedValue,
      reasoning: result.reasoning,
      isPrimarySource: true,
    }, '[source-check]');

    // Store aggregate verdict for facts too — ensures the most recent
    // check result is reflected in the verdicts table, fixing stale
    // contradictions that persisted after re-checks confirmed data.
    await storeAggregateVerdict({
      recordType: 'fact',
      recordId: factId,
      verdict: result.verdict,
      confidence: result.confidence,
      reasoning: result.reasoning,
      sourcesChecked: 1,
    }, '[source-check]').catch((e: unknown) => {
      console.warn(`[source-check] Failed to store fact verdict: ${e instanceof Error ? e.message : String(e)}`);
    });
  } else if (item.data.kind === 'record') {
    const recordData = item.data as RecordItemData;

    // Store individual verification evidence
    await storeSourceCheckEvidence({
      recordType: recordData.recordType,
      recordId: recordData.recordId,
      sourceUrl: result.sourceUrl,
      verdict: result.verdict,
      confidence: result.confidence,
      extractedValue: result.extractedValue,
      reasoning: result.reasoning,
      entityId: recordData.entityId,
    }, '[source-check]');

    // Store aggregate verdict
    await storeAggregateVerdict({
      recordType: recordData.recordType,
      recordId: recordData.recordId,
      verdict: result.verdict,
      confidence: result.confidence,
      reasoning: result.reasoning,
      sourcesChecked: 1,
      entityId: recordData.entityId,
    }, '[source-check]').catch((e: unknown) => {
      console.warn(`[source-check] Failed to store record verdict: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  // Entity-type verifications are logged but not stored in a specific endpoint
  // since they are discovery-based (web search) rather than source-based
}

// ── Main orchestrator ────────────────────────────────────────────────

export async function orchestrateCommand(
  args: string[],
  options: OrchestrateOptions,
): Promise<CommandResult> {
  const isDryRun = options['dry-run'] || options.dryRun;
  const budgetLimit = options.budget ? parseFloat(String(options.budget)) : undefined;
  const itemLimit = options.limit ? parseInt(String(options.limit), 10) : undefined;
  const typeFilter = options.type as VerifyItemKind | 'all' | undefined;
  const entityTypeFilter = (options['entity-type'] || options.entityType) as string | undefined;
  const sourceMode = (options.source as string) ?? 'existing';
  const useWebSearch = sourceMode === 'web-search' || sourceMode === 'all';

  // Validate type filter
  const validTypes = ['fact', 'record', 'entity', 'all'];
  if (typeFilter && !validTypes.includes(typeFilter)) {
    return {
      exitCode: 1,
      output: `Invalid --type: ${typeFilter}\nValid values: ${validTypes.join(', ')}`,
    };
  }

  // Validate source mode
  const validSources = ['existing', 'web-search', 'all'];
  if (!validSources.includes(sourceMode)) {
    return {
      exitCode: 1,
      output: `Invalid --source: ${sourceMode}\nValid values: ${validSources.join(', ')}`,
    };
  }

  const shouldCollectFacts = !typeFilter || typeFilter === 'all' || typeFilter === 'fact';
  const shouldCollectRecords = !typeFilter || typeFilter === 'all' || typeFilter === 'record';
  const shouldCollectEntities = (typeFilter === 'entity' || typeFilter === 'all') && useWebSearch;

  console.log('\x1b[1mVerification Orchestrator\x1b[0m');
  console.log('');

  // ── Step 1: Load data and fetch existing verification status ──
  console.log('Loading data...');

  const [db, pages, existingKBVerdicts, existingRecordVerdicts] = await Promise.all([
    Promise.resolve(loadDatabase()),
    Promise.resolve(loadPages()),
    shouldCollectFacts ? fetchExistingKBVerdicts() : Promise.resolve(new Map<string, VerifiedFactInfo>()),
    shouldCollectRecords ? fetchExistingRecordVerdicts() : Promise.resolve(new Map<string, VerifiedRecordInfo>()),
  ]);

  const entities = db.typedEntities ?? db.entities ?? [];

  // ── Step 2: Collect verification items ──
  console.log('Collecting verification items...');

  const allItems: VerifyItem[] = [];

  if (shouldCollectFacts) {
    try {
      const kb = await loadGraphFull();
      const factItems = collectFactItems(kb, existingKBVerdicts, pages, entityTypeFilter);
      allItems.push(...factItems);
      console.log(`  Facts: ${factItems.length} items`);
    } catch (e: unknown) {
      console.warn(`  Facts: failed to load FactBase: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (shouldCollectRecords) {
    const recordItems = await collectRecordItems(existingRecordVerdicts, entityTypeFilter);
    allItems.push(...recordItems);
    console.log(`  Records: ${recordItems.length} items`);
  }

  if (shouldCollectEntities) {
    const entityItems = collectEntityItems(entities, pages, entityTypeFilter);
    allItems.push(...entityItems);
    console.log(`  Entities (web search): ${entityItems.length} items`);
  }

  if (allItems.length === 0) {
    return { exitCode: 0, output: 'No verification items found.' };
  }

  // ── Step 3: Sort by priority (highest first) ──
  allItems.sort((a, b) => b.priority - a.priority);

  // ── Step 4: Apply limits ──
  let itemsToVerify = allItems;

  if (budgetLimit !== undefined) {
    const maxByBudget = Math.floor(budgetLimit / ESTIMATED_COST_PER_VERIFICATION);
    if (maxByBudget < itemsToVerify.length) {
      itemsToVerify = itemsToVerify.slice(0, maxByBudget);
    }
  }

  if (itemLimit !== undefined && itemLimit > 0 && itemLimit < itemsToVerify.length) {
    itemsToVerify = itemsToVerify.slice(0, itemLimit);
  }

  // ── Step 5: Report or execute ──
  const estimatedCost = itemsToVerify.length * ESTIMATED_COST_PER_VERIFICATION;

  if (isDryRun) {
    return formatDryRunOutput(allItems, itemsToVerify, estimatedCost, existingKBVerdicts, existingRecordVerdicts, options);
  }

  // ── Live execution ──
  const concurrency = options.concurrency ? parseInt(String(options.concurrency), 10) : 5;
  const client = createLlmClient();
  const summary: OrchestrationSummary = {
    total: itemsToVerify.length,
    confirmed: 0,
    contradicted: 0,
    unverifiable: 0,
    outdated: 0,
    partial: 0,
    errors: 0,
    estimatedCost,
    actualVerified: 0,
    byKind: {
      fact: { total: 0, verified: 0 },
      record: { total: 0, verified: 0 },
      entity: { total: 0, verified: 0 },
    },
    results: [],
    failures: [],
  };

  // Count by kind
  for (const item of itemsToVerify) {
    summary.byKind[item.kind].total++;
  }

  const concurrencyLabel = concurrency > 1 ? `, concurrency=${concurrency}` : '';
  console.log(`\n\x1b[1mVerifying ${itemsToVerify.length} items (est. \$${estimatedCost.toFixed(2)}${concurrencyLabel})...\x1b[0m\n`);

  let completedCount = 0;

  async function processItem(item: VerifyItem, index: number): Promise<void> {
    const kindLabel = item.kind.toUpperCase().padEnd(7);

    const result = await verifySingleItem(item, client, useWebSearch);

    // Synchronize output and summary updates
    completedCount++;
    const progress = `[${completedCount}/${itemsToVerify.length}]`;

    if ('error' in result) {
      summary.errors++;
      summary.failures.push(result);
      const typeTag = result.errorType ? ` [${result.errorType}]` : '';
      console.log(`  ${progress} ${kindLabel} ${item.description.slice(0, 80)}`);
      console.log(`    \x1b[31mERROR${typeTag}: ${result.error}\x1b[0m`);
    } else {
      summary[result.verdict]++;
      summary.actualVerified++;
      summary.byKind[item.kind].verified++;
      summary.results.push(result);

      const color = result.verdict === 'confirmed'
        ? '\x1b[32m'
        : result.verdict === 'contradicted'
          ? '\x1b[31m'
          : '\x1b[33m';
      console.log(`  ${progress} ${kindLabel} ${item.description.slice(0, 80)}`);
      console.log(`    ${color}${result.verdict}\x1b[0m (confidence: ${(result.confidence * 100).toFixed(0)}%)`);

      if (result.verdict === 'contradicted' || result.verdict === 'outdated') {
        console.log(`    Source says: ${result.extractedValue.slice(0, 100)}`);
      }

      // Store result (best-effort)
      await storeResult(item, result).catch((e: unknown) => {
        console.warn(`    \x1b[33mStorage failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
      });
    }
  }

  // Run with concurrency-limited pool
  if (concurrency <= 1) {
    for (let i = 0; i < itemsToVerify.length; i++) {
      await processItem(itemsToVerify[i], i);
    }
  } else {
    const executing = new Set<Promise<void>>();
    for (let i = 0; i < itemsToVerify.length; i++) {
      const p = processItem(itemsToVerify[i], i).finally(() => executing.delete(p));
      executing.add(p);
      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
  }

  // ── Build summary output ──
  if (options.ci) {
    return {
      exitCode: summary.contradicted > 0 ? 1 : 0,
      output: JSON.stringify(summary),
    };
  }

  return { exitCode: summary.contradicted > 0 ? 1 : 0, output: formatSummaryOutput(summary) };
}

// ── Output formatting ────────────────────────────────────────────────

function formatDryRunOutput(
  allItems: VerifyItem[],
  selectedItems: VerifyItem[],
  estimatedCost: number,
  kbVerdicts: Map<string, VerifiedFactInfo>,
  recordVerdicts: Map<string, VerifiedRecordInfo>,
  options: OrchestrateOptions,
): CommandResult {
  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        totalAvailable: allItems.length,
        selected: selectedItems.length,
        estimatedCost,
        items: selectedItems.map(i => ({
          id: i.id,
          kind: i.kind,
          description: i.description,
          entityType: i.entityType,
          priority: i.priority,
          neverVerified: i.neverVerified,
          sourceUrl: i.sourceUrl,
        })),
      }),
    };
  }

  const lines: string[] = [];
  lines.push(`\x1b[1mDry run: ${selectedItems.length} of ${allItems.length} items would be verified\x1b[0m`);
  lines.push(`Estimated cost: \$${estimatedCost.toFixed(2)}`);
  lines.push('');

  // Coverage summary
  const neverVerifiedFacts = allItems.filter(i => i.kind === 'fact' && i.neverVerified).length;
  const totalFacts = allItems.filter(i => i.kind === 'fact').length;
  const neverVerifiedRecords = allItems.filter(i => i.kind === 'record' && i.neverVerified).length;
  const totalRecords = allItems.filter(i => i.kind === 'record').length;
  const totalEntities = allItems.filter(i => i.kind === 'entity').length;

  lines.push('\x1b[1mCoverage overview:\x1b[0m');
  if (totalFacts > 0) {
    lines.push(`  Facts:    ${totalFacts} total, ${neverVerifiedFacts} never verified (${kbVerdicts.size} existing verdicts)`);
  }
  if (totalRecords > 0) {
    lines.push(`  Records:  ${totalRecords} total, ${neverVerifiedRecords} never verified (${recordVerdicts.size} existing verdicts)`);
  }
  if (totalEntities > 0) {
    lines.push(`  Entities: ${totalEntities} without sources (web search candidates)`);
  }
  lines.push('');

  // Entity type breakdown
  const typeCounts = new Map<string, number>();
  for (const item of selectedItems) {
    typeCounts.set(item.entityType, (typeCounts.get(item.entityType) ?? 0) + 1);
  }

  lines.push('\x1b[1mSelected items by type:\x1b[0m');
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${type.padEnd(20)} ${count}`);
  }
  lines.push('');

  // Top items by priority
  const topItems = selectedItems.slice(0, 20);
  const header = `${'Kind'.padEnd(8)} ${'Priority'.padEnd(10)} ${'Status'.padEnd(12)} ${'Description'.padEnd(60)} Source`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(120));

  for (const item of topItems) {
    const status = item.neverVerified ? '\x1b[33mnew\x1b[0m' : 'verified';
    const desc = item.description.length > 58 ? item.description.slice(0, 57) + '...' : item.description;
    const src = item.sourceUrl
      ? (item.sourceUrl.length > 30 ? item.sourceUrl.slice(0, 29) + '...' : item.sourceUrl)
      : '(none)';
    lines.push(
      `${item.kind.padEnd(8)} ${String(item.priority.toFixed(0)).padEnd(10)} ${status.padEnd(12)} ${desc.padEnd(60)} ${src}`,
    );
  }

  if (selectedItems.length > 20) {
    lines.push(`  ... and ${selectedItems.length - 20} more items`);
  }

  lines.push('');
  lines.push('Use without --dry-run to run verification with LLM.');

  return { exitCode: 0, output: lines.join('\n') };
}

function formatSummaryOutput(summary: OrchestrationSummary): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[1m=== Verification Orchestrator Summary ===\x1b[0m');
  lines.push(`Total items:    ${summary.total}`);
  lines.push(`Verified:       ${summary.actualVerified}`);
  lines.push(`Est. cost:      \$${summary.estimatedCost.toFixed(2)}`);
  lines.push('');
  lines.push(`\x1b[32mConfirmed:      ${summary.confirmed}\x1b[0m`);
  lines.push(`\x1b[31mContradicted:   ${summary.contradicted}\x1b[0m`);
  lines.push(`\x1b[33mUnverifiable:   ${summary.unverifiable}\x1b[0m`);
  lines.push(`\x1b[33mOutdated:       ${summary.outdated}\x1b[0m`);
  lines.push(`\x1b[33mPartial:        ${summary.partial}\x1b[0m`);
  lines.push(`\x1b[31mErrors:         ${summary.errors}\x1b[0m`);
  lines.push('');

  // By kind
  lines.push('\x1b[1mBy verification type:\x1b[0m');
  for (const [kind, counts] of Object.entries(summary.byKind)) {
    if (counts.total > 0) {
      lines.push(`  ${kind.padEnd(10)} ${counts.verified}/${counts.total} verified`);
    }
  }

  // Contradictions detail
  const contradictions = summary.results.filter(r => r.verdict === 'contradicted');
  if (contradictions.length > 0) {
    lines.push('');
    lines.push('\x1b[31m\x1b[1mContradictions:\x1b[0m');
    for (const c of contradictions) {
      lines.push(`  [${c.kind}] ${c.description}`);
      lines.push(`    Source says: ${c.extractedValue.slice(0, 200)}`);
      lines.push(`    Reason: ${c.reasoning}`);
      lines.push(`    URL: ${c.sourceUrl}`);
      lines.push('');
    }
  }

  // Outdated detail
  const outdated = summary.results.filter(r => r.verdict === 'outdated');
  if (outdated.length > 0) {
    lines.push('');
    lines.push('\x1b[33m\x1b[1mOutdated:\x1b[0m');
    for (const o of outdated) {
      lines.push(`  [${o.kind}] ${o.description}`);
      lines.push(`    Source says: ${o.extractedValue.slice(0, 200)}`);
      lines.push('');
    }
  }

  // Error breakdown
  if (summary.failures.length > 0) {
    lines.push('');
    lines.push(`\x1b[31m\x1b[1mErrors (${summary.failures.length}):\x1b[0m`);
    const shown = summary.failures.slice(0, 10);
    for (const f of shown) {
      const typeTag = f.errorType ? ` [${f.errorType}]` : '';
      lines.push(`  [${f.kind}] ${f.description.slice(0, 60)}${typeTag}: ${f.error}`);
    }
    if (summary.failures.length > 10) {
      lines.push(`  ... and ${summary.failures.length - 10} more errors`);
    }

    // Error type breakdown
    const errorTypeCounts = new Map<string, number>();
    for (const f of summary.failures) {
      const type = f.errorType ?? 'unknown';
      errorTypeCounts.set(type, (errorTypeCounts.get(type) ?? 0) + 1);
    }
    if (errorTypeCounts.size > 1) {
      lines.push('');
      lines.push('  Error breakdown:');
      for (const [type, cnt] of [...errorTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`    ${type}: ${cnt}`);
      }
    }
  }

  return lines.join('\n');
}

// ── Stats command (merged from records-verify) ───────────────────────

async function statsCommand(): Promise<CommandResult> {
  const response = await apiRequest<{
    total: number;
    by_verdict: Record<string, number>;
    by_type: Record<string, number>;
    needs_recheck: number;
    avg_confidence: number;
  }>('GET', '/api/verifications/stats');

  if (!response.ok) {
    return { exitCode: 1, output: `Failed to fetch stats: ${response.error}` };
  }

  const stats = response.data;
  const lines: string[] = [];
  lines.push('\x1b[1m=== Verification Stats ===\x1b[0m');
  lines.push(`Total verdicts: ${stats.total}`);
  lines.push(`Average confidence: ${(stats.avg_confidence * 100).toFixed(0)}%`);
  lines.push(`Needs recheck: ${stats.needs_recheck}`);
  lines.push('');

  lines.push('\x1b[1mBy verdict:\x1b[0m');
  for (const [verdict, cnt] of Object.entries(stats.by_verdict)) {
    const color = verdict === 'confirmed' ? '\x1b[32m' : verdict === 'contradicted' ? '\x1b[31m' : '\x1b[33m';
    lines.push(`  ${color}${verdict.padEnd(15)}\x1b[0m ${cnt}`);
  }
  lines.push('');

  lines.push('\x1b[1mBy record type:\x1b[0m');
  for (const [type, cnt] of Object.entries(stats.by_type)) {
    lines.push(`  ${type.padEnd(20)} ${cnt}`);
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Record-type subcommand routing (merged from records-verify) ──────

/** Map plural/singular CLI subcommand names to RecordType */
const RECORD_TYPE_MAP: Record<string, RecordType> = {
  grant: 'grant',
  grants: 'grant',
  personnel: 'personnel',
  division: 'division',
  divisions: 'division',
  'funding-program': 'funding-program',
  'funding-programs': 'funding-program',
  'funding-round': 'funding-round',
  'funding-rounds': 'funding-round',
  investment: 'investment',
  investments: 'investment',
  'equity-position': 'equity-position',
  'equity-positions': 'equity-position',
  publication: 'publication',
  publications: 'publication',
  'benchmark-result': 'benchmark-result',
  'benchmark-results': 'benchmark-result',
  'entity-event': 'entity-event',
  'entity-events': 'entity-event',
  'entity-assessment': 'entity-assessment',
  'entity-assessments': 'entity-assessment',
  'secondary-market-price': 'secondary-market-price',
  'secondary-market-prices': 'secondary-market-price',
};

/**
 * Unified verify command entry point.
 * Routes to orchestrate, stats, or record-type-specific verification.
 */
async function verifyCommand(
  args: string[],
  options: OrchestrateOptions,
): Promise<CommandResult> {
  const subcommand = args[0];

  // Stats subcommand
  if (subcommand === 'stats') {
    return statsCommand();
  }

  // sync-things subcommand (deprecated)
  if (subcommand === 'sync-things') {
    return { exitCode: 0, output: 'sync-things is no longer needed -- Things table no longer stores verdicts.' };
  }

  // orchestrate subcommand (explicit)
  if (subcommand === 'orchestrate') {
    return orchestrateCommand(args.slice(1), options);
  }

  // Record type subcommands (grants, personnel, etc.)
  const mapped = subcommand ? RECORD_TYPE_MAP[subcommand] : undefined;
  if (mapped) {
    // Route to orchestrate with --type=record and entity-type filter
    const recordOptions: OrchestrateOptions = {
      ...options,
      type: 'record',
    };
    return orchestrateCommand(args.slice(1), recordOptions);
  }

  // Default: run orchestrate
  return orchestrateCommand(args, options);
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: verifyCommand,
  orchestrate: orchestrateCommand,
  stats: statsCommand,
};

export function getHelp(): string {
  return `
Verification — verify structured data against source URLs

Usage:
  crux tb verify [options]                 Run verification across all data layers
  crux tb verify orchestrate [options]     Full orchestrated verification with prioritization
  crux tb verify stats                     Show verification coverage report
  crux tb verify grants                    Verify all grants (shorthand for --type=record)
  crux tb verify personnel                 Verify all personnel records
  crux tb verify divisions                 Verify all divisions
  crux tb verify funding-programs          Verify funding programs
  crux tb verify funding-rounds            Verify funding rounds
  crux tb verify investments               Verify investments
  crux tb verify equity-positions          Verify equity positions
  crux tb verify publications              Verify publications
  crux tb verify benchmark-results         Verify benchmark results
  crux tb verify entity-events             Verify entity events
  crux tb verify entity-assessments        Verify entity assessments
  crux tb verify secondary-market-prices   Verify secondary market prices

Options:
  --budget=N             Max dollars to spend on LLM calls (est. ~$0.01/item)
  --limit=N              Max number of items to verify
  --type=X               What to verify: fact | record | entity | all (default: all)
  --entity-type=X        Filter by entity type (organization, person, ai-model, ...)
  --entity=X             Filter by entity (org or person stableId)
  --source=X             Source mode: existing | web-search | all (default: existing)
  --concurrency=N        Number of parallel verifications (default: 5)
  --dry-run              Show what would be verified without calling LLM
  --ci                   JSON output

Priority order:
  1. Never-verified items first
  2. Items flagged needsRecheck
  3. High reader/research importance (from page data)
  4. Volatile entity types (ai-model, organization, person)
  5. Staleness (oldest verification first)

Examples:
  crux tb verify --dry-run                              Preview verification plan
  crux tb verify orchestrate --budget=5 --limit=100     Verify up to 100 items, $5 cap
  crux tb verify grants --dry-run                       Preview which grants would be checked
  crux tb verify personnel --entity=anthropic           Verify Anthropic personnel records
  crux tb verify stats                                  Show verification coverage
  crux tb verify --type=fact --entity-type=organization  Verify organization facts
  crux tb verify --type=record --limit=20               Verify 20 records
`;
}
