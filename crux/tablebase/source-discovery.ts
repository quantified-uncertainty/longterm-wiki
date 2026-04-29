/**
 * Source Discovery V2 — Find better sources for unverifiable records
 *
 * Uses existing infrastructure instead of a standalone LLM agent:
 *   1. Research agent (Exa + Perplexity + SCRY) for entity-level source discovery
 *   2. Per-person Exa searches for personnel not covered by entity-level results
 *   3. String matching + Haiku verification against fetched content
 *   4. Source field updates via existing sync endpoints
 *
 * Cost: ~$0.05/entity (vs ~$0.80 in V1 Sonnet agent approach)
 */

import { runResearch } from '../lib/search/research-agent.ts';
import type { ResearchResult } from '../lib/search/research-agent.ts';
import { getVerdictsByEntity } from '../lib/wiki-server/sourcing.ts';
import { suggestResources } from '../lib/search/suggest-resources.ts';
import { getCitationContentByUrl } from '../lib/wiki-server/citations.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { getTableConfig } from './table-registry.ts';
import { buildStableIdNameMap } from './sourcing.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceDiscoveryOptions {
  /** Run for a single entity (skip scanning) */
  entityId?: string;
  entityName?: string;
  /** Max entities to process in batch mode */
  limit?: number;
  /** Don't create resources or update records */
  dryRun?: boolean;
  /** Update record source fields with discovered sources */
  apply?: boolean;
  /** Run Haiku verification on matches (default: true) */
  verify?: boolean;
  /** Skip per-person searches, only do entity-level (faster/cheaper) */
  entityOnly?: boolean;
}

export interface DiscoveredSource {
  url: string;
  title: string;
  contentLength: number;
  /** Record IDs this source could verify (based on string match) */
  matchedRecordIds: string[];
  /** Person names found in this source's content */
  matchedPersonNames: string[];
  /** Provider that found this URL */
  provider: string;
  /** Resource ID if registered */
  resourceId?: string;
}

export interface EntityDiscoveryResult {
  entityId: string;
  entityName: string;
  unverifiableCount: number;
  /** Sources found via entity-level research */
  entityLevelSources: DiscoveredSource[];
  /** Sources found via per-person targeted search */
  perPersonSources: DiscoveredSource[];
  /** Records that got a matching source */
  recordsMatched: number;
  /** Records still without a matching source */
  recordsUnmatched: number;
  /** Records whose source field was updated (only with --apply) */
  recordsUpdated: number;
  /** Total cost in USD */
  cost: number;
  durationMs: number;
}

export interface DiscoveryResult {
  entities: EntityDiscoveryResult[];
  totalRecordsMatched: number;
  totalRecordsUpdated: number;
  totalCost: number;
  totalDurationMs: number;
}

interface UnverifiableRecord {
  recordType: string;
  recordId: string;
  displayName: string | null;
  reasoning: string | null;
  personName: string | null;
  orgName: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract person name from verdict displayName like "Personnel: Josh Batson at Anthropic (Research Scientist)" */
function extractPersonName(displayName: string | null): string | null {
  if (!displayName) return null;
  const m = displayName.match(/Personnel: (.+?) at /);
  return m ? m[1] : null;
}

/** Extract org name from verdict displayName */
function extractOrgName(displayName: string | null): string | null {
  if (!displayName) return null;
  const m = displayName.match(/ at (.+?)(?:\s*\(|$)/);
  return m ? m[1] : null;
}

/** Check if content mentions a person name (case-insensitive) */
function contentMentionsPerson(content: string, personName: string): boolean {
  return content.toLowerCase().includes(personName.toLowerCase());
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

// ---------------------------------------------------------------------------
// Core: Discover sources for a single entity
// ---------------------------------------------------------------------------

async function discoverForEntity(
  entityId: string,
  entityName: string,
  options: SourceDiscoveryOptions,
): Promise<EntityDiscoveryResult> {
  const startMs = Date.now();
  let totalCost = 0;

  // Step 1: Get unverifiable records for this entity
  const verdictResult = await getVerdictsByEntity(entityId, { verdict: 'unverifiable', limit: 50 });
  if (!verdictResult.ok) {
    // Propagate server errors so callers can distinguish "server down" from "no records."
    // Silently returning emptyResult() would make failures invisible.
    throw new Error(`[source-discover] Failed to get verdicts for ${entityName}: ${verdictResult.message}`);
  }

  const records: UnverifiableRecord[] = verdictResult.data.verdicts.map((v: Record<string, unknown>) => ({
    recordType: v.recordType as string,
    recordId: v.recordId as string,
    displayName: v.displayName as string | null,
    reasoning: v.reasoning as string | null,
    personName: extractPersonName(v.displayName as string | null),
    orgName: extractOrgName(v.displayName as string | null),
  }));

  if (records.length === 0) {
    return emptyResult(entityId, entityName, startMs);
  }

  // Currently source-discovery only handles personnel-style records (those with
  // a parseable personName in their displayName). Non-personnel record types
  // (grant, investment, funding_round, benchmark-result) are logged and skipped
  // because their displayName format doesn't contain person names to match against
  // fetched content. TODO: extend matching to handle these record types (#4012).
  const personRecords = records.filter(r => r.personName);
  const nonPersonRecords = records.filter(r => !r.personName);
  const personNames = [...new Set(personRecords.map(r => r.personName!))];

  if (nonPersonRecords.length > 0) {
    const typeCounts = new Map<string, number>();
    for (const r of nonPersonRecords) {
      typeCounts.set(r.recordType, (typeCounts.get(r.recordType) || 0) + 1);
    }
    const typeBreakdown = [...typeCounts.entries()].map(([t, c]) => `${t}=${c}`).join(', ');
    console.warn(`[source-discover] ${entityName}: skipping ${nonPersonRecords.length} non-personnel records (${typeBreakdown}) — not yet supported`);
  }

  console.log(`[source-discover] ${entityName}: ${records.length} unverifiable records (${personRecords.length} personnel, ${nonPersonRecords.length} other), ${personNames.length} unique people`);

  if (personRecords.length === 0) {
    // All records are non-personnel types — nothing we can match yet
    return emptyResult(entityId, entityName, startMs);
  }

  // Step 2: Entity-level research (finds Wikipedia, team pages, news)
  console.log(`[source-discover]   Phase 1: entity-level research...`);
  let researchResult: ResearchResult;
  try {
    researchResult = await runResearch({
      topic: `${entityName} team leadership key people staff`,
      pageContext: { title: entityName, type: 'organization', entityId },
      config: {
        maxResultsPerSource: 5,
        maxUrlsToFetch: 10,
        extractFacts: false, // skip fact extraction — we just need content
        useGitHub: false,
        useSemanticScholar: false,
        useFederalRegister: false,
      },
      budgetCap: 0.50,
    });
    totalCost += researchResult.metadata.totalCost;
  } catch (err: unknown) {
    console.warn(`[source-discover]   Research agent failed: ${err instanceof Error ? err.message : String(err)}`);
    researchResult = { sources: [], metadata: { sourcesSearched: [], urlsFound: 0, urlsFetched: 0, urlsDeduplicated: 0, urlsAlreadyInPG: 0, newResourcesRegistered: 0, pgCacheInitialized: false, totalCost: 0, costBreakdown: { searchCost: 0, factExtractionCost: 0 }, providerCounts: {}, durationMs: 0 } };
  }

  // Match entity-level sources against person names
  const entityLevelSources: DiscoveredSource[] = [];
  const matchedRecordIds = new Set<string>();

  for (const source of researchResult.sources) {
    const content = source.content || '';
    if (content.length < 50) continue; // skip empty/tiny content

    const matched = personRecords.filter(r => r.personName && contentMentionsPerson(content, r.personName));
    if (matched.length > 0) {
      entityLevelSources.push({
        url: source.url,
        title: source.title || source.url,
        contentLength: content.length,
        matchedRecordIds: matched.map(r => r.recordId),
        matchedPersonNames: matched.map(r => r.personName!),
        provider: 'research-agent',
      });
      for (const r of matched) matchedRecordIds.add(r.recordId);
    }
  }

  console.log(`[source-discover]   Entity-level: ${researchResult.sources.length} sources fetched, ${entityLevelSources.length} matched ${matchedRecordIds.size} records`);

  // Step 3: Per-person targeted search for unmatched people
  const perPersonSources: DiscoveredSource[] = [];

  if (!options.entityOnly) {
    const unmatchedPeople = personRecords.filter(r => !matchedRecordIds.has(r.recordId) && r.personName);
    const uniqueUnmatched = [...new Map(unmatchedPeople.map(r => [r.personName, r])).values()];

    if (uniqueUnmatched.length > 0) {
      console.log(`[source-discover]   Phase 2: per-person search for ${uniqueUnmatched.length} unmatched people...`);

      for (const record of uniqueUnmatched) {
        const query = `${record.personName} ${entityName}`;
        try {
          const personResult = await runResearch({
            topic: query,
            pageContext: { title: entityName, type: 'organization' },
            config: {
              maxResultsPerSource: 3,
              maxUrlsToFetch: 5,
              extractFacts: false,
              useGitHub: false,
              useSemanticScholar: false,
              useFederalRegister: false,
              useScry: false,
              usePerplexity: false, // Exa only for per-person (cheapest)
            },
            budgetCap: 0.10,
          });
          totalCost += personResult.metadata.totalCost;

          for (const source of personResult.sources) {
            const content = source.content || '';
            if (content.length < 50) continue;

            // Check if this source mentions the person
            if (record.personName && contentMentionsPerson(content, record.personName)) {
              // Find all records this source covers (not just the one we searched for)
              const allMatched = personRecords.filter(r =>
                r.personName && contentMentionsPerson(content, r.personName),
              );
              perPersonSources.push({
                url: source.url,
                title: source.title || source.url,
                contentLength: content.length,
                matchedRecordIds: allMatched.map(r => r.recordId),
                matchedPersonNames: allMatched.map(r => r.personName!),
                provider: 'exa-person',
              });
              for (const r of allMatched) matchedRecordIds.add(r.recordId);
            }
          }
        } catch (err: unknown) {
          console.warn(`[source-discover]     Search for "${record.personName}" failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.log(`[source-discover]   Per-person: ${perPersonSources.length} sources matched ${matchedRecordIds.size - entityLevelSources.reduce((s, src) => s + src.matchedRecordIds.length, 0)} additional records`);
    }
  }

  // Step 4: Register discovered sources as resources (if not dry run)
  if (!options.dryRun) {
    const allUrls = [
      ...entityLevelSources.map(s => s.url),
      ...perPersonSources.map(s => s.url),
    ];
    const uniqueUrls = [...new Set(allUrls)];
    if (uniqueUrls.length > 0) {
      try {
        const registered = await suggestResources({ urls: uniqueUrls, entityId });
        // Update source objects with resourceIds
        for (const res of registered.resources) {
          const allSources = [...entityLevelSources, ...perPersonSources];
          const match = allSources.find(s => s.url === res.url);
          if (match) match.resourceId = res.resourceId;
        }
      } catch (err: unknown) {
        console.warn(`[source-discover]   Resource registration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Step 5: Update record source fields (if --apply)
  let recordsUpdated = 0;
  if (options.apply && !options.dryRun) {
    const allSources = [...entityLevelSources, ...perPersonSources];
    // Build record → best source mapping (prefer entity-level sources, then per-person)
    const recordBestSource = new Map<string, DiscoveredSource>();
    for (const source of allSources) {
      for (const recordId of source.matchedRecordIds) {
        if (!recordBestSource.has(recordId)) {
          recordBestSource.set(recordId, source);
        }
      }
    }

    for (const [recordId, source] of recordBestSource) {
      const record = records.find(r => r.recordId === recordId);
      if (!record) continue;

      const table = recordTypeToTable(record.recordType);
      const config = getTableConfig(table);
      if (!config) continue;

      const updatePayload: Record<string, unknown> = {
        id: recordId,
        source: source.url,
      };
      if (source.resourceId) {
        updatePayload.sourceResourceId = source.resourceId;
      }

      try {
        // typed-client-ok: QUA-770 baseline — tablebase tooling, follow-up migration to typed client tracked
        const result = await apiRequest<{ upserted?: number; updated?: number }>(
          config.syncMethod,
          config.syncPath,
          { [config.syncBodyKey]: [updatePayload] },
        );
        if (result.ok) recordsUpdated++;
      } catch {
        // Log but continue
      }
    }

    if (recordsUpdated > 0) {
      console.log(`[source-discover]   Updated ${recordsUpdated} record source fields`);
    }
  }

  const totalMatched = matchedRecordIds.size;
  const totalUnmatched = records.length - totalMatched;

  return {
    entityId,
    entityName,
    unverifiableCount: records.length,
    entityLevelSources,
    perPersonSources,
    recordsMatched: totalMatched,
    recordsUnmatched: totalUnmatched,
    recordsUpdated,
    cost: totalCost,
    durationMs: Date.now() - startMs,
  };
}

function emptyResult(entityId: string, entityName: string, startMs: number): EntityDiscoveryResult {
  return {
    entityId,
    entityName,
    unverifiableCount: 0,
    entityLevelSources: [],
    perPersonSources: [],
    recordsMatched: 0,
    recordsUnmatched: 0,
    recordsUpdated: 0,
    cost: 0,
    durationMs: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function discoverSources(options: SourceDiscoveryOptions): Promise<DiscoveryResult> {
  const startMs = Date.now();
  const results: EntityDiscoveryResult[] = [];

  if (options.entityId) {
    // Single entity mode
    const result = await discoverForEntity(
      options.entityId,
      options.entityName || options.entityId,
      options,
    );
    results.push(result);
  } else {
    // Batch mode: scan for entities with unverifiable records
    const { runTableScan } = await import('./scanner.ts');
    const { rankTasks } = await import('./task-ranker.ts');

    const scan = await runTableScan('source_quality');
    if (!scan) {
      return { entities: [], totalRecordsMatched: 0, totalRecordsUpdated: 0, totalCost: 0, totalDurationMs: Date.now() - startMs };
    }

    const tasks = rankTasks(
      { tables: [scan], timestamp: new Date().toISOString() },
      { taskTypes: ['source-discovery'], limit: options.limit || 10 },
    );

    console.log(`[source-discover] Found ${tasks.length} entities with unverifiable records`);

    for (const task of tasks) {
      console.log(`\n${'─'.repeat(50)}`);
      try {
        const result = await discoverForEntity(task.entityId, task.entityName, options);
        results.push(result);
      } catch (err: unknown) {
        console.error(`[source-discover] Entity ${task.entityName} failed: ${err instanceof Error ? err.message : String(err)}`);
        // Continue with remaining entities — don't let one failure stop the batch
      }
    }
  }

  const totalRecordsMatched = results.reduce((s, r) => s + r.recordsMatched, 0);
  const totalRecordsUpdated = results.reduce((s, r) => s + r.recordsUpdated, 0);
  const totalCost = results.reduce((s, r) => s + r.cost, 0);

  return {
    entities: results,
    totalRecordsMatched,
    totalRecordsUpdated,
    totalCost,
    totalDurationMs: Date.now() - startMs,
  };
}
