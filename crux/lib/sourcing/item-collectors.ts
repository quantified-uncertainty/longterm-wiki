/**
 * Source-check item collection.
 * Gathers FactBase facts, structured records, and entities into VerifyItem lists
 * for the orchestrator to prioritize and dispatch.
 */

import type { PageEntry, Entity } from '../content-types.ts';
import type { LoadedKB } from '../factbase-loader.ts';
import type { Fact, Entity as FBEntity } from '../../../packages/factbase/src/types.ts';
import { formatFactValue } from '../../../packages/factbase/src/format.ts';
import { apiRequest } from '../wiki-server/client.ts';
import { listVerdicts } from '../wiki-server/sourcing-client.ts';
import { VALID_RECORD_TYPES, type RecordType } from '../../../apps/wiki-server/src/api-types.ts';
import { resolveName, isResolvableName, extractEntityId, extractEntityDisplayName } from './record-fields.ts';
import {
  ENTITY_TYPE_PRIORITY,
  API_PAGE_LIMIT,
  type VerifyItem,
  type SourcingedFactInfo,
  type SourcingedRecordInfo,
} from './orchestrator-types.ts';
import { buildRecordDescription, extractRecordFields } from './record-descriptions.ts';
import { computeFactPriority, computeRecordPriority } from './priority.ts';

/** Extract a raw string representation of a fact's value (before display formatting). */
function extractRawValue(fact: Fact): string | undefined {
  const v = fact.value;
  if (v.type === 'number') return String(v.value);
  if (v.type === 'text') return v.value;
  if (v.type === 'range') return `${v.low}–${v.high}`;
  if (v.type === 'date') return v.value;
  if (v.type === 'boolean') return String(v.value);
  return undefined;
}

// ── Web search for entities without sources ──────────────────────────

/**
 * Perform a simple web search for an entity using Exa API.
 * Falls back gracefully if EXA_API_KEY is not set.
 */
export async function searchForEntity(entity: Entity): Promise<string[]> {
  let apiKey: string | undefined;
  try {
    const { getApiKey } = await import('../api-keys.ts');
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
      console.warn(`[sourcing] Exa search failed: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json() as { results?: Array<{ url: string }> };
    return (data.results ?? []).map(r => r.url).filter(Boolean);
  } catch (e: unknown) {
    console.warn(`[sourcing] Web search failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

// ── Wiki-server stats fetching ───────────────────────────────────────

/**
 * Fetch existing KB sourcing verdicts to identify already-checked facts.
 * Returns a Map from factId to sourcing info.
 */
export async function fetchExistingKBVerdicts(): Promise<Map<string, SourcingedFactInfo>> {
  const map = new Map<string, SourcingedFactInfo>();

  try {
    let offset = 0;

    while (true) {
      const response = await listVerdicts({ recordType: 'fact', limit: API_PAGE_LIMIT, offset });

      if (!response.ok || !response.data) {
        if (offset === 0) break; // First page failed — return empty map
        // Mid-pagination failure — discard partial data to avoid truncated dataset
        console.warn(`[sourcing] KB verdict pagination failed at offset ${offset}, discarding partial data`);
        return new Map();
      }

      for (const v of response.data.verdicts) {
        map.set(v.recordId, {
          factId: v.recordId,
          verdict: v.verdict,
          checkedAt: v.lastComputedAt,
          needsRecheck: v.needsRecheck,
        });
      }

      if (response.data.verdicts.length < API_PAGE_LIMIT || map.size >= response.data.total) break;
      offset += API_PAGE_LIMIT;
    }
  } catch (e: unknown) {
    console.warn(`[sourcing] Could not fetch KB verdicts: ${e instanceof Error ? e.message : String(e)}`);
  }

  return map;
}

/**
 * Fetch existing record sourcing verdicts.
 * Returns a Map from "recordType:recordId" to sourcing info.
 */
export async function fetchExistingRecordVerdicts(): Promise<Map<string, SourcingedRecordInfo>> {
  const map = new Map<string, SourcingedRecordInfo>();

  try {
    const PAGE_SIZE = 200; // Must not exceed wiki-server MAX_PAGE_SIZE (200)
    let offset = 0;

    while (true) {
      const response = await listVerdicts({ limit: PAGE_SIZE, offset });

      if (!response.ok || !response.data) {
        throw new Error(`Failed to fetch record verdicts at offset ${offset}`);
      }

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
    // On pagination failure, discard partial data to avoid processing a truncated dataset
    console.warn(`[sourcing] Could not fetch record verdicts: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }

  return map;
}

// ── Item collection ──────────────────────────────────────────────────

/**
 * Collect FactBase facts as sourcing items.
 */
export function collectFactItems(
  kb: LoadedKB,
  existingVerdicts: Map<string, SourcingedFactInfo>,
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
      // Skip properties marked as not verifiable (e.g., social media handles, self-referential URLs)
      if (property?.verifiable === false) continue;
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
          rawValue: extractRawValue(fact),
        },
      });
    }
  }

  return items;
}

/**
 * Collect structured records as sourcing items.
 */
export async function collectRecordItems(
  existingVerdicts: Map<string, SourcingedRecordInfo>,
  entityTypeFilter?: string,
  tableFilter?: string,
): Promise<VerifyItem[]> {
  const items: VerifyItem[] = [];

  // Determine which record types to scan
  // --table filters to a specific record type (e.g. "personnel", "grant")
  const typesToScan = tableFilter
    ? VALID_RECORD_TYPES.filter(t => t === tableFilter)
    : entityTypeFilter
      ? VALID_RECORD_TYPES.filter(t => t === entityTypeFilter)
      : [...VALID_RECORD_TYPES];

  for (const recordType of typesToScan) {
    let apiBasePath: string;
    switch (recordType) {
      case 'grant': apiBasePath = '/api/grants/all'; break;
      case 'personnel': apiBasePath = '/api/personnel/all'; break;
      case 'division': apiBasePath = '/api/divisions/all'; break;
      case 'funding-program': apiBasePath = '/api/funding-programs/all'; break;
      case 'funding-round': apiBasePath = '/api/funding-rounds/all'; break;
      case 'investment': apiBasePath = '/api/investments/all'; break;
      case 'equity-position': apiBasePath = '/api/equity-positions/all'; break;
      case 'policy-stakeholder': apiBasePath = '/api/policy-stakeholders/all'; break;
      case 'publication': apiBasePath = '/api/publications/all'; break;
      case 'benchmark-result': apiBasePath = '/api/benchmark-results/all'; break;
      case 'entity-event': apiBasePath = '/api/entity-events/all'; break;
      case 'entity-assessment': apiBasePath = '/api/entity-assessments/all'; break;
      case 'secondary-market-price': apiBasePath = '/api/secondary-market-prices/all'; break;
      // citation and wiki-page are valid record types for verdicts but don't have
      // /all API endpoints for bulk collection — skip them intentionally.
      case 'citation':
      case 'wiki-page':
        continue;
      default:
        console.warn(`[sourcing] Unknown record type '${recordType}' — skipping`);
        continue;
    }

    try {
      // Paginate through all records (server-side MAX_PAGE_SIZE is typically 200)
      const allRawItems: Record<string, unknown>[] = [];
      let offset = 0;

      while (true) {
        const apiPath = `${apiBasePath}?limit=${API_PAGE_LIMIT}&offset=${offset}`;
        const response = await apiRequest<Record<string, unknown>>('GET', apiPath);
        if (!response.ok) {
          console.warn(`[sourcing] Failed to fetch ${recordType}: ${response.message}`);
          break;
        }

        // Extract items array from the response (API uses different keys)
        const data = response.data;
        const rawItems = (
          data.items ?? data.grants ?? data.personnel ?? data.divisions ??
          data.programs ?? data.fundingPrograms ??
          data.rounds ?? data.fundingRounds ??
          data.investments ??
          data.positions ?? data.equityPositions ??
          data.stakeholders ?? data.policyStakeholders ??
          data.publications ?? data.benchmarkResults ??
          data.events ?? data.entityEvents ??
          data.assessments ?? data.entityAssessments ??
          data.prices ?? data.secondaryMarketPrices ??
          (Array.isArray(data) ? data : [])
        ) as Record<string, unknown>[];

        allRawItems.push(...rawItems);

        // Stop if we got fewer items than the page size, or we've reached the total
        const total = typeof data.total === 'number' ? data.total : undefined;
        if (rawItems.length < API_PAGE_LIMIT || (total !== undefined && allRawItems.length >= total)) break;
        offset += API_PAGE_LIMIT;
      }

      for (const item of allRawItems) {
        // Some record types use 'sourceUrl' instead of 'source' (e.g. benchmark-result)
        const source = item.source ?? item.sourceUrl;
        if (typeof source !== 'string' || !source) continue;

        const id = String(item.id ?? '');
        const key = `${recordType}:${id}`;
        const existing = existingVerdicts.get(key);

        const description = buildRecordDescription(recordType, item);
        const fields = extractRecordFields(recordType, item);

        // Skip records where any key name is an unresolvable stableId.
        // The LLM can't verify "aAFe7DRvPv is a researcher at Anthropic" against a source —
        // it needs both the person and org names to be human-readable.
        if (recordType === 'personnel') {
          const personName = resolveName(item, 'personResolvedName', 'personDisplayName', 'personId');
          const orgName = resolveName(item, 'orgResolvedName', 'orgDisplayName', 'organizationId');
          if (!isResolvableName(personName) || !isResolvableName(orgName)) continue;
        } else if (recordType === 'investment') {
          const investorName = resolveName(item, 'investorResolvedName', 'investorDisplayName', 'investorId');
          const companyName = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
          if (!isResolvableName(investorName) || !isResolvableName(companyName)) continue;
        } else if (recordType === 'funding-round') {
          const companyName = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
          if (!isResolvableName(companyName)) continue;
        } else if (recordType === 'benchmark-result') {
          const modelName = resolveName(item, 'modelResolvedName', 'modelDisplayName', 'modelId');
          if (!isResolvableName(modelName)) continue;
        }

        const priority = computeRecordPriority(recordType, existing);

        const entityId = extractEntityId(recordType, item);
        const entityDisplayName = extractEntityDisplayName(recordType, item);

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
            displayName: description,
            entityDisplayName,
          },
        });
      }
    } catch (e: unknown) {
      console.warn(`[sourcing] Error collecting ${recordType}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return items;
}

/**
 * Collect entities for web-search-based sourcing (entities without sources).
 */
export function collectEntityItems(
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
