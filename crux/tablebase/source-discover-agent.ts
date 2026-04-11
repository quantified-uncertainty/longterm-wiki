/**
 * Source Discover Agent V3 — Claims-first source discovery
 *
 * Replaces the string-matching approach in source-discovery.ts (V2) with a
 * claims-first pipeline that:
 *   1. Gets unverifiable records for an entity via getFailures()
 *   2. Runs runResearch() to discover sources
 *   3. Registers resources via suggestResources()
 *   4. Extracts structured claims from fetched content via Haiku
 *   5. Submits claims via proposeClaims()
 *   6. Optionally polls for verification via getClaimStatus()
 *
 * All record types are handled from day one — the claim extraction prompt
 * is type-agnostic. No string-matching heuristics.
 *
 * Part of QUA-210.
 */

import { runResearch } from '../lib/search/research-agent.ts';
import type { ResearchResult } from '../lib/search/research-agent.ts';
import { getFailures } from '../lib/wiki-server/source-checks.ts';
import type { FailuresResponse } from '../lib/wiki-server/source-checks.ts';
import { suggestResources } from '../lib/search/suggest-resources.ts';
import { proposeClaims, getClaimStatus } from '../lib/wiki-server/claims.ts';
import type { ProposeClaims } from '../../apps/wiki-server/src/api-types.ts';
import { extractClaims } from './claim-extractor.ts';
import type { UnverifiableRecord, ExtractedClaim } from './claim-extractor.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceDiscoverAgentOptions {
  /** Entity slug or stableId */
  entityId: string;
  /** Human-readable entity name (for search queries) */
  entityName?: string;
  /** Max unverifiable records to process (default: 50) */
  limit?: number;
  /** Preview mode — discover sources and extract claims, but don't submit (default) */
  dryRun?: boolean;
  /** Submit claims to the claims pipeline for async verification */
  apply?: boolean;
  /** Submit claims but don't apply verified results to records */
  claimsOnly?: boolean;
  /** Record types to filter by (default: all) */
  recordTypes?: string[];
  /** Budget cap for research in USD (default: 1.00) */
  budgetCap?: number;
  /** Poll for claim verification status after submitting (default: false) */
  pollVerification?: boolean;
  /** Max seconds to poll for verification (default: 120) */
  pollTimeoutSec?: number;
}

export interface SourceWithClaims {
  url: string;
  title: string;
  contentLength: number;
  claims: ExtractedClaim[];
  resourceId?: string;
}

export interface AgentResult {
  entityId: string;
  entityName: string;
  /** Total unverifiable records found */
  unverifiableCount: number;
  /** Records filtered by record type (if applicable) */
  recordsProcessed: number;
  /** Sources discovered via research agent */
  sourcesDiscovered: number;
  /** Sources that yielded at least one claim */
  sourcesWithClaims: number;
  /** Total claims extracted across all sources */
  claimsExtracted: number;
  /** Claims submitted to the pipeline (0 if dry-run) */
  claimsSubmitted: number;
  /** Batch ID from proposeClaims (null if dry-run) */
  batchId: string | null;
  /** Verification status if polling was enabled */
  verificationStatus: VerificationPollResult | null;
  /** Per-source breakdown */
  sources: SourceWithClaims[];
  /** Cost in USD */
  cost: number;
  /** Duration in ms */
  durationMs: number;
  /** Non-null when the run exited early — distinguishes "no unverifiable
   *  records" from "research failed" or "no usable sources found". */
  skipReason?: string;
}

export interface VerificationPollResult {
  total: number;
  verified: number;
  contradicted: number;
  unverifiable: number;
  pending: number;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a verdict row from the failures API to our internal type. */
function toUnverifiableRecord(v: FailuresResponse['items'][number]): UnverifiableRecord {
  return {
    recordType: v.recordType,
    recordId: v.recordId,
    fieldName: v.fieldName ?? null,
    displayName: v.displayName ?? null,
    reasoning: v.reasoning ?? null,
    entityId: v.entityId ?? null,
  };
}

/**
 * Build a search query from the entity name and record types.
 * More specific queries yield better sources.
 */
function buildSearchQuery(entityName: string, records: UnverifiableRecord[]): string {
  // Collect unique record types
  const types = [...new Set(records.map(r => r.recordType))];

  // Build a descriptive query
  const typeParts: string[] = [];
  for (const t of types) {
    switch (t) {
      case 'personnel': typeParts.push('team leadership staff employees'); break;
      case 'grant': typeParts.push('grants funding awarded'); break;
      case 'funding-round': typeParts.push('funding rounds investment raised'); break;
      case 'investment': typeParts.push('investments portfolio'); break;
      case 'division': typeParts.push('departments divisions teams'); break;
      case 'publication': typeParts.push('research papers publications'); break;
      case 'benchmark-result': typeParts.push('benchmark results performance'); break;
      case 'entity-event': typeParts.push('events milestones announcements'); break;
      default: typeParts.push(t.replace(/-/g, ' ')); break;
    }
  }

  const typeString = typeParts.length > 0 ? ` ${typeParts.join(' ')}` : '';
  return `${entityName}${typeString}`;
}

// ---------------------------------------------------------------------------
// Core agent
// ---------------------------------------------------------------------------

/**
 * Run the claims-first source discovery agent for a single entity.
 */
export async function runSourceDiscoverAgent(
  options: SourceDiscoverAgentOptions,
): Promise<AgentResult> {
  const startMs = Date.now();
  let totalCost = 0;

  const entityId = options.entityId;
  const entityName = options.entityName || entityId;
  const limit = options.limit ?? 50;
  const budgetCap = options.budgetCap ?? 1.00;
  const isDryRun = options.dryRun ?? (!options.apply && !options.claimsOnly);

  // ─── Step 1: Get unverifiable records ─────────────────────────────
  console.log(`[source-discover-agent] ${entityName}: fetching unverifiable records...`);

  const failuresResult = await getFailures({
    entity_id: entityId,
    error_type: 'unverifiable',
    limit,
  });

  if (!failuresResult.ok) {
    throw new Error(
      `[source-discover-agent] Failed to get failures for ${entityName}: ${failuresResult.message}`,
    );
  }

  let records = failuresResult.data.items.map(toUnverifiableRecord);

  // Filter by record type if specified
  if (options.recordTypes && options.recordTypes.length > 0) {
    const typeSet = new Set(options.recordTypes);
    records = records.filter(r => typeSet.has(r.recordType));
  }

  if (records.length === 0) {
    console.log(`[source-discover-agent] ${entityName}: no unverifiable records found.`);
    return emptyResult(entityId, entityName, startMs, 'no unverifiable records');
  }

  // Log record type breakdown
  const typeCounts = new Map<string, number>();
  for (const r of records) {
    typeCounts.set(r.recordType, (typeCounts.get(r.recordType) || 0) + 1);
  }
  const typeBreakdown = [...typeCounts.entries()].map(([t, c]) => `${t}=${c}`).join(', ');
  console.log(
    `[source-discover-agent] ${entityName}: ${records.length} unverifiable records (${typeBreakdown})`,
  );

  // ─── Step 2: Research — discover sources ──────────────────────────
  console.log(`[source-discover-agent] ${entityName}: running research...`);

  const searchQuery = buildSearchQuery(entityName, records);
  let researchResult: ResearchResult;

  try {
    researchResult = await runResearch({
      topic: searchQuery,
      pageContext: { title: entityName, type: 'organization', entityId },
      config: {
        maxResultsPerSource: 5,
        maxUrlsToFetch: 10,
        extractFacts: false, // skip fact extraction — we extract claims instead
        useGitHub: false,
        useSemanticScholar: false,
        useFederalRegister: false,
      },
      budgetCap,
    });
    totalCost += researchResult.metadata.totalCost;
  } catch (err: unknown) {
    console.warn(
      `[source-discover-agent] Research failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return emptyResult(entityId, entityName, startMs, `research failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const fetchedSources = researchResult.sources.filter(s => s.content && s.content.length >= 50);
  console.log(
    `[source-discover-agent] ${entityName}: ${researchResult.sources.length} sources fetched, ${fetchedSources.length} with content`,
  );

  if (fetchedSources.length === 0) {
    return emptyResult(entityId, entityName, startMs, 'no sources with usable content (all < 50 chars)');
  }

  // ─── Step 3: Register resources ───────────────────────────────────
  const sourceUrls = fetchedSources.map(s => s.url);
  const urlToResourceId = new Map<string, string>();

  if (!isDryRun) {
    try {
      const registered = await suggestResources({ urls: sourceUrls, entityId });
      for (const res of registered.resources) {
        urlToResourceId.set(res.url, res.resourceId);
      }
      console.log(
        `[source-discover-agent] ${entityName}: registered ${registered.resources.length} resources`,
      );
    } catch (err: unknown) {
      console.warn(
        `[source-discover-agent] Resource registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Step 4: Extract claims from each source ──────────────────────
  console.log(`[source-discover-agent] ${entityName}: extracting claims from ${fetchedSources.length} sources...`);

  const sourcesWithClaims: SourceWithClaims[] = [];
  let totalClaimsExtracted = 0;

  for (const source of fetchedSources) {
    const content = source.content || '';
    const extractionResult = await extractClaims(content, source.url, records);
    totalCost += extractionResult.cost;

    const sourceEntry: SourceWithClaims = {
      url: source.url,
      title: source.title || source.url,
      contentLength: content.length,
      claims: extractionResult.claims,
      resourceId: urlToResourceId.get(source.url),
    };

    if (extractionResult.claims.length > 0) {
      sourcesWithClaims.push(sourceEntry);
      totalClaimsExtracted += extractionResult.claims.length;
    }
  }

  console.log(
    `[source-discover-agent] ${entityName}: extracted ${totalClaimsExtracted} claims from ${sourcesWithClaims.length}/${fetchedSources.length} sources`,
  );

  // ─── Step 5: Submit claims (if not dry-run) ───────────────────────
  let claimsSubmitted = 0;
  let batchId: string | null = null;

  if (!isDryRun && totalClaimsExtracted > 0) {
    // Build the claims payload — group by target table
    const claimsByTable = new Map<string, ProposeClaims['claims']>();

    for (const source of sourcesWithClaims) {
      for (const claim of source.claims) {
        // Determine target table from the matched records
        for (const recordId of claim.matchedRecordIds) {
          const record = records.find(r => r.recordId === recordId);
          if (!record) continue;

          const table = record.recordType;
          if (!claimsByTable.has(table)) {
            claimsByTable.set(table, []);
          }

          claimsByTable.get(table)!.push({
            claimText: claim.claimText,
            targetField: claim.targetField ?? undefined,
            proposedValue: claim.proposedValue ?? undefined,
            sourceUrl: source.url,
            resourceId: source.resourceId,
            agentEvidence: `Extracted from ${source.title} by source-discover-agent`,
          });
        }
      }
    }

    // Submit claims for each target table, batching at 100 (API limit).
    // All batch IDs are collected so none are silently lost.
    const allBatchIds: string[] = [];

    for (const [targetTable, claims] of claimsByTable) {
      if (claims.length === 0) continue;

      // Submit in 100-claim chunks instead of silently truncating
      for (let offset = 0; offset < claims.length; offset += 100) {
        const batch = claims.slice(offset, offset + 100);

        try {
          const result = await proposeClaims({
            entityId,
            targetTable,
            claims: batch,
          });

          if (result.ok) {
            claimsSubmitted += batch.length;
            allBatchIds.push(result.data.batchId);
            batchId = result.data.batchId; // keep last for polling
            console.log(
              `[source-discover-agent] ${entityName}: submitted ${batch.length}/${claims.length} claims for ${targetTable} (batch: ${batchId})`,
            );
          } else {
            console.warn(
              `[source-discover-agent] ${entityName}: claim submission failed for ${targetTable}: ${result.message}`,
            );
          }
        } catch (err: unknown) {
          console.warn(
            `[source-discover-agent] ${entityName}: claim submission error for ${targetTable}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (allBatchIds.length > 1) {
      console.log(
        `[source-discover-agent] ${entityName}: ${allBatchIds.length} batches submitted: ${allBatchIds.join(', ')}`,
      );
    }
  }

  // ─── Step 6: Poll verification (if enabled) ───────────────────────
  let verificationStatus: VerificationPollResult | null = null;

  if (options.pollVerification && batchId) {
    console.log(`[source-discover-agent] ${entityName}: polling verification status...`);
    verificationStatus = await pollForVerification(
      batchId,
      options.pollTimeoutSec ?? 120,
    );
  }

  // ─── Result ───────────────────────────────────────────────────────
  const result: AgentResult = {
    entityId,
    entityName,
    unverifiableCount: failuresResult.data.total,
    recordsProcessed: records.length,
    sourcesDiscovered: fetchedSources.length,
    sourcesWithClaims: sourcesWithClaims.length,
    claimsExtracted: totalClaimsExtracted,
    claimsSubmitted,
    batchId,
    verificationStatus,
    sources: sourcesWithClaims,
    cost: totalCost,
    durationMs: Date.now() - startMs,
  };

  return result;
}

// ---------------------------------------------------------------------------
// Verification polling
// ---------------------------------------------------------------------------

async function pollForVerification(
  batchId: string,
  timeoutSec: number,
): Promise<VerificationPollResult> {
  const startMs = Date.now();
  const timeoutMs = timeoutSec * 1000;
  const pollIntervalMs = 5_000;

  while (Date.now() - startMs < timeoutMs) {
    const statusResult = await getClaimStatus(batchId);
    if (!statusResult.ok) {
      console.warn(`[source-discover-agent] Status poll failed: ${statusResult.message}`);
      // Wait and retry
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      continue;
    }

    const data = statusResult.data;
    const pending = data.claims.filter(
      (c: { status: string }) => c.status === 'pending' || c.status === 'verifying',
    ).length;

    if (pending === 0) {
      // All claims resolved
      return {
        total: data.claims.length,
        verified: data.claims.filter((c: { status: string }) => c.status === 'verified').length,
        contradicted: data.claims.filter((c: { status: string }) => c.status === 'contradicted').length,
        unverifiable: data.claims.filter((c: { status: string }) => c.status === 'unverifiable').length,
        pending: 0,
        timedOut: false,
      };
    }

    console.log(
      `[source-discover-agent] Verification: ${data.claims.length - pending}/${data.claims.length} resolved, ${pending} pending...`,
    );

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  // Timed out — return partial status
  const finalResult = await getClaimStatus(batchId);
  if (!finalResult.ok) {
    return { total: 0, verified: 0, contradicted: 0, unverifiable: 0, pending: 0, timedOut: true };
  }

  const claims = finalResult.data.claims;
  return {
    total: claims.length,
    verified: claims.filter((c: { status: string }) => c.status === 'verified').length,
    contradicted: claims.filter((c: { status: string }) => c.status === 'contradicted').length,
    unverifiable: claims.filter((c: { status: string }) => c.status === 'unverifiable').length,
    pending: claims.filter(
      (c: { status: string }) => c.status === 'pending' || c.status === 'verifying',
    ).length,
    timedOut: true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyResult(
  entityId: string,
  entityName: string,
  startMs: number,
  skipReason?: string,
): AgentResult {
  return {
    entityId,
    entityName,
    unverifiableCount: 0,
    recordsProcessed: 0,
    sourcesDiscovered: 0,
    sourcesWithClaims: 0,
    claimsExtracted: 0,
    claimsSubmitted: 0,
    batchId: null,
    verificationStatus: null,
    sources: [],
    cost: 0,
    durationMs: Date.now() - startMs,
    ...(skipReason ? { skipReason } : {}),
  };
}
