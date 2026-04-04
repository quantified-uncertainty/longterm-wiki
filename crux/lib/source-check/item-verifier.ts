/**
 * Source-check item verification.
 * Handles LLM prompt building, deterministic matching, single-item verification,
 * and result storage for the orchestrator.
 */

import type { Entity } from '../content-types.ts';
import { createLlmClient } from '../llm.ts';
import type { SourceCheckVerdict } from '../../../apps/wiki-server/src/api-types.ts';
import type { DataSourceManifest } from '../grant-import/manifests/types.ts';
import { getLatestSnapshot } from '../wiki-server/data-sources.ts';
import {
  fetchSourceContent,
  callLlmForSourceCheck,
  storeSourceCheckEvidence,
  storeAggregateVerdict,
  SOURCE_CHECK_CONSTANTS,
  MODELS,
} from './index.ts';
import {
  SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES,
  SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS,
  SOURCE_CHECK_RESPONSE_FORMAT,
} from './prompt-guidelines.ts';
import { matchRecordAgainstSnapshot } from './deterministic-matcher.ts';
import { searchForEntity } from './item-collectors.ts';
import type {
  VerifyItem,
  VerifyResult,
  VerifyError,
  FactItemData,
  RecordItemData,
} from './orchestrator-types.ts';

const { PROMPT_CONTENT_LENGTH } = SOURCE_CHECK_CONSTANTS;

/** Cache parsed snapshots to avoid re-fetching and re-parsing per grant */
export const snapshotCache = new Map<string, { rawContent: string; manifest: DataSourceManifest } | null>();

// ── LLM prompt builders ─────────────────────────────────────────────

export function buildFactVerificationPrompt(
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
${sourceText.slice(0, PROMPT_CONTENT_LENGTH)}
---

Does the source text confirm, contradict, or not address this claim?

${SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES}

${SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS}

${SOURCE_CHECK_RESPONSE_FORMAT}`;
}

export function buildRecordVerificationPrompt(
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
${sourceText.slice(0, PROMPT_CONTENT_LENGTH)}
---

Does the source text confirm, contradict, or not address the claims in this record?

${SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES}

${SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS}

${SOURCE_CHECK_RESPONSE_FORMAT}`;
}

export function buildEntityVerificationPrompt(
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
${sourceText.slice(0, PROMPT_CONTENT_LENGTH)}
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

// ── Deterministic matching ──────────────────────────────────────────

/**
 * Try deterministic row-matching for a grant record against its source snapshot.
 * Returns a VerifyResult if deterministic matching produces a definitive answer,
 * or null to fall through to LLM verification.
 */
export async function tryDeterministicMatch(item: VerifyItem): Promise<VerifyResult | null> {
  if (item.data.kind !== 'record') return null;

  // Look up the source URL to find which data source this grant came from
  const sourceUrl = item.sourceUrl;
  if (!sourceUrl) return null;

  // Find a manifest whose fetchUrl matches the grant's source URL
  const { MANIFESTS } = await import('../grant-import/manifests/index.ts');
  const manifest = Object.values(MANIFESTS).find(m => {
    if (!m.fetchUrl) return false;
    // Exact match or the source URL contains the fetchUrl
    if (sourceUrl === m.fetchUrl) return true;
    if (sourceUrl.includes(m.fetchUrl)) return true;
    // Domain-level match for per-record URLs (e.g., manifund.org/projects/X matches manifund.org/api/v0/projects)
    try {
      const sourceHost = new URL(sourceUrl).hostname;
      const fetchHost = new URL(m.fetchUrl).hostname;
      return sourceHost === fetchHost;
    } catch { return false; }
  });
  if (!manifest || manifest.schema.fields.length === 0) return null;

  // Fetch the latest snapshot for this data source (cached to avoid re-fetching per grant)
  const cacheKey = manifest.sourceId;
  let cached = snapshotCache.get(cacheKey);
  if (cached === undefined) {
    // Not in cache — fetch and cache
    const snapshotResult = await getLatestSnapshot(manifest.sourceId);
    if (!snapshotResult.ok || !snapshotResult.data) {
      snapshotCache.set(cacheKey, null);
      return null;
    }
    const snapshot = snapshotResult.data as { rawContent: string };
    if (!snapshot.rawContent) {
      snapshotCache.set(cacheKey, null);
      return null;
    }
    cached = { rawContent: snapshot.rawContent, manifest };
    snapshotCache.set(cacheKey, cached);
  }
  if (cached === null) return null;

  // Run deterministic matching
  const result = matchRecordAgainstSnapshot(
    item.data.fields as Record<string, unknown>,
    cached.rawContent,
    manifest,
  );

  // Only use deterministic result if it's definitive
  if (!result.matched && result.confidence < 0.3) {
    // Very low confidence — fall through to LLM for a second opinion
    return null;
  }

  const verdict: SourceCheckVerdict = result.matched
    ? (result.confidence >= 0.9 ? 'confirmed' : 'partial')
    : 'unverifiable';

  return {
    itemId: item.id,
    kind: item.kind,
    description: item.description,
    verdict,
    confidence: result.confidence,
    extractedValue: result.matchedRow
      ? `Matched row: ${JSON.stringify(result.matchedRow).slice(0, 200)}`
      : 'No matching row found in source snapshot',
    reasoning: `[deterministic-row-match] ${result.reasoning}`,
    sourceUrl: item.sourceUrl ?? manifest.fetchUrl ?? '',
    checkerModel: 'deterministic-row-match',
  };
}

// ── Single-item verification ────────────────────────────────────────

export async function verifySingleItem(
  item: VerifyItem,
  client: ReturnType<typeof createLlmClient>,
  useWebSearch: boolean,
): Promise<VerifyResult | VerifyError> {
  // ── Deterministic matching path (Discussion #3567 Phase 3) ──
  // For record-type items (grants, etc.), try deterministic row-matching
  // against a source snapshot before falling back to LLM verification.
  if (item.data.kind === 'record' && item.data.recordType === 'grant') {
    try {
      const deterministicResult = await tryDeterministicMatch(item);
      if (deterministicResult) return deterministicResult;
    } catch (e: unknown) {
      // Fall through to LLM verification on any error
      console.warn(`[source-check] Deterministic matching failed for ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
      // Dead links get a proper verdict instead of an error — saves LLM cost
      // and makes dead links distinguishable from other unverifiable causes.
      if (fetchResult.errorType === 'dead_link') {
        return {
          itemId: item.id,
          kind: item.kind,
          description: item.description,
          verdict: 'unverifiable' as SourceCheckVerdict,
          confidence: 1.0,
          extractedValue: '',
          reasoning: `[dead_link] ${fetchResult.errorMessage ?? 'Source URL is dead'}`,
          sourceUrl,
          errorType: fetchResult.errorType,
          checkerModel: 'dead-link-detector',
        };
      }
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

export async function storeResult(item: VerifyItem, result: VerifyResult): Promise<void> {
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
      checkerModel: result.checkerModel,
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
      checkerModel: result.checkerModel,
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
      displayName: recordData.displayName,
      entityDisplayName: recordData.entityDisplayName,
    }, '[source-check]').catch((e: unknown) => {
      console.warn(`[source-check] Failed to store record verdict: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  // Entity-type verifications are logged but not stored in a specific endpoint
  // since they are discovery-based (web search) rather than source-based
}

// Re-export MODELS so orchestrator.ts can use it without importing from index
export { MODELS };
