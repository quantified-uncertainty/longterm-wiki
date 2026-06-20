/**
 * Source-check item sourcing.
 * Handles LLM prompt building, deterministic matching, single-item sourcing,
 * and result storage for the orchestrator.
 */

import type { Entity } from '../content-types.ts';
import { createLlmClient } from '../llm.ts';
import type { SourcingVerdict } from '../../../apps/wiki-server/src/api-types.ts';
import type { DataSourceManifest } from '../grant-import/manifests/types.ts';
import { getLatestSnapshot } from '../wiki-server/data-sources.ts';
import {
  fetchSourceContent,
  callLlmForSourcing,
  storeSourcingEvidence,
  storeAggregateVerdict,
  SOURCE_CHECK_CONSTANTS,
  MODELS,
} from './index.ts';
import {
  SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES,
  SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS,
  SOURCE_CHECK_RESPONSE_FORMAT,
} from './prompt-guidelines.ts';
import { buildScorecardGradeExcerpt } from './scorecard-grade-excerpt.ts';
import { matchRecordAgainstSnapshot } from './deterministic-matcher.ts';
import { tryWikidataMatch } from './wikidata-matcher.ts';
import { tryOpenAlexMatch } from './openalex-matcher.ts';
import { tryUrlResolvesVerify } from './url-resolves-verifier.ts';
import { searchForEntity } from './item-collectors.ts';
import { hostMatches } from '@longterm-wiki/url-utils';
import { isRelevanceGateEnabled, runRelevanceGate } from './relevance-gate.ts';
import type {
  VerifyItem,
  VerifyResult,
  VerifyError,
  FactItemData,
  RecordItemData,
} from './orchestrator-types.ts';

const { PROMPT_CONTENT_LENGTH } = SOURCE_CHECK_CONSTANTS;

// ── Numeric formatting for LLM prompts ─────────────────────────────

/**
 * Format a large number as a human-readable string for LLM prompts.
 * The LLM needs to match "1234000000" against "$1.234 billion" in source text —
 * showing just the raw number leads to false-positive contradictions.
 *
 * Examples:
 *   formatNumericForPrompt(1234000000) → "1,234,000,000 (i.e. ~1.23 billion)"
 *   formatNumericForPrompt(50000000)   → "50,000,000 (i.e. ~50 million)"
 *   formatNumericForPrompt(1500)       → "1,500"
 *   formatNumericForPrompt(42)         → "42"
 */
export function formatNumericForPrompt(value: number): string {
  const formatted = value.toLocaleString('en-US');

  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (abs >= 1e12) {
    const trillions = abs / 1e12;
    return `${formatted} (i.e. ${sign}~${trimTrailingZero(trillions.toFixed(2))} trillion)`;
  }
  if (abs >= 1e9) {
    const billions = abs / 1e9;
    return `${formatted} (i.e. ${sign}~${trimTrailingZero(billions.toFixed(2))} billion)`;
  }
  if (abs >= 1e6) {
    const millions = abs / 1e6;
    return `${formatted} (i.e. ${sign}~${trimTrailingZero(millions.toFixed(2))} million)`;
  }
  return formatted;
}

/** Remove trailing zeros after decimal: "1.20" → "1.2", "1.00" → "1" */
function trimTrailingZero(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

/**
 * Known monetary field names used in record sourcing.
 * When these fields contain numbers, we annotate them with human-readable equivalents
 * in the LLM prompt to prevent rounding false positives.
 */
const MONETARY_FIELDS = new Set([
  'amount', 'raised', 'valuation', 'budget', 'impliedValuation',
  'pricePerShare', 'totalBudget',
]);

/** Cache parsed snapshots to avoid re-fetching and re-parsing per grant */
export const snapshotCache = new Map<string, { rawContent: string; manifest: DataSourceManifest } | null>();

// ── LLM prompt builders ─────────────────────────────────────────────

export function buildFactSourcingPrompt(
  data: FactItemData,
  sourceText: string,
): string {
  const asOfStr = data.fact.asOf ? ` (as of ${data.fact.asOf})` : '';
  const notesStr = data.fact.notes ? `\nAdditional context: ${data.fact.notes}` : '';
  // Include exact stored value when it differs from the display value to avoid rounding false positives.
  // Format the raw value with human-readable annotation so the LLM can match it against source text
  // (e.g., "1,234,000,000 (i.e. ~1.23 billion)" instead of just "1234000000").
  let rawSuffix = '';
  if (data.rawValue && data.rawValue !== data.formattedValue) {
    const numericRaw = Number(data.rawValue);
    if (Number.isFinite(numericRaw) && Math.abs(numericRaw) >= 1e6) {
      rawSuffix = ` (exact stored value: ${formatNumericForPrompt(numericRaw)})`;
    } else {
      rawSuffix = ` (exact stored value: ${data.rawValue})`;
    }
  }

  return `You are a fact-checker. Given the source text below, verify this claim.

Claim: ${data.entity.name}'s ${data.propertyName} = ${data.formattedValue}${rawSuffix}${asOfStr}${notesStr}

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

export function buildRecordSourcingPrompt(
  data: RecordItemData,
  description: string,
  sourceText: string,
): string {
  const fieldsStr = Object.entries(data.fields)
    .filter(([, v]) => v != null)
    .map(([k, v]) => {
      // Annotate large monetary fields with human-readable equivalents to prevent
      // false-positive contradictions. Without this, the LLM sees "amount: 1234000000"
      // and must figure out on its own that it equals "$1.234 billion" from the source.
      if (typeof v === 'number' && MONETARY_FIELDS.has(k) && Math.abs(v) >= 1e6) {
        return `  ${k}: ${formatNumericForPrompt(v)}`;
      }
      return `  ${k}: ${v}`;
    })
    .join('\n');

  // QUA-978: scorecard pages (FLI Index, FMTI, etc.) lay out per-dimension
  // grade tables sequentially. Each dimension's deep section commonly sits
  // past the 30K prompt window, leaving the LLM with only the overall
  // grade — and it then false-positive-contradicts the per-dim claim
  // ("claimed D, source shows C+ overall"). Dispatch to a domain-aware
  // extractor that locates the dimension's deep section. Other record
  // types use the unchanged first-N-chars slice.
  const excerpt =
    data.recordType === 'scorecard_grade'
      ? buildScorecardGradeExcerpt(data.fields, sourceText, PROMPT_CONTENT_LENGTH)
      : sourceText.slice(0, PROMPT_CONTENT_LENGTH);

  return `You are a fact-checker. Given the source text below, verify this structured data record.

Record type: ${data.recordType}
Record: ${description}
Key fields:
${fieldsStr}

Source text (excerpt):
---
${excerpt}
---

Does the source text confirm, contradict, or not address the claims in this record?

${SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES}

${SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS}

${SOURCE_CHECK_RESPONSE_FORMAT}`;
}

export function buildEntitySourcingPrompt(
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

${SOURCE_CHECK_RESPONSE_FORMAT}`;
}

// ── Deterministic matching ──────────────────────────────────────────

/**
 * Try deterministic row-matching for a record (grant or investment) against its source snapshot.
 * Returns a VerifyResult if deterministic matching produces a definitive answer,
 * or null to fall through to LLM sourcing.
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

  const verdict: SourcingVerdict = result.matched
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

// ── Single-item sourcing ────────────────────────────────────────

export async function verifySingleItem(
  item: VerifyItem,
  client: ReturnType<typeof createLlmClient>,
  useWebSearch: boolean,
): Promise<VerifyResult | VerifyError> {
  // ── URL-resolves verifier (QUA-927) ──
  // Cheapest path: facts with `verifierKind: url-resolves` are verified by an
  // HTTP HEAD request, no LLM, no source-content fetch. Returns null when the
  // fact isn't tagged for url-resolves verification, so this is safe to run
  // unconditionally.
  if (item.data.kind === 'fact' && item.data.verifierKind === 'url-resolves') {
    try {
      const urlResolvesResult = await tryUrlResolvesVerify(item);
      if (urlResolvesResult) return urlResolvesResult;
    } catch (e: unknown) {
      // Don't fall through to LLM content-claim — these properties (wikipedia-url,
      // github-profile, …) have no claim text to verify; the LLM path is meaningless
      // here. Return unverifiable so the orchestrator records *something* and a
      // future pass retries.
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[sourcing] url-resolves verifier failed for ${item.id}: ${message}`);
      return {
        itemId: item.id,
        kind: item.kind,
        description: item.description,
        verdict: 'unverifiable' as SourcingVerdict,
        confidence: 0.7,
        extractedValue: '',
        reasoning: `[url-resolves] verifier threw: ${message}`,
        sourceUrl: item.sourceUrl ?? '',
        checkerModel: 'url-resolves',
      };
    }
  }

  // ── Deterministic matching path (Discussion #3567 Phase 3) ──
  // For any record-type item, try deterministic row-matching against a source
  // snapshot before falling back to LLM sourcing. tryDeterministicMatch
  // returns null when no manifest matches the source URL, so this is safe for
  // record types that don't have manifests yet — they fall through to LLM.
  if (item.data.kind === 'record') {
    try {
      const deterministicResult = await tryDeterministicMatch(item);
      if (deterministicResult) return deterministicResult;
    } catch (e: unknown) {
      // Fall through to LLM sourcing on any error
      console.warn(`[sourcing] Deterministic matching failed for ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Wikidata deterministic matching (QUA-92) ──
  // For fact-type items sourced from Wikidata, use the structured API to verify
  // instead of fetching HTML + LLM. Saves ~$4.25/week for ~414 Wikidata-sourced facts.
  if (item.data.kind === 'fact' && item.sourceUrl && hostMatches(item.sourceUrl, 'wikidata.org')) {
    try {
      const wikidataResult = await tryWikidataMatch(item);
      if (wikidataResult) return wikidataResult;
    } catch (e: unknown) {
      // Fall through to LLM sourcing on any error
      console.warn(`[sourcing] Wikidata matching failed for ${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // OpenAlex deterministic matching for publishing personnel. Returns null
  // on miss (non-researcher, homonym risk, ambiguous) → falls through to LLM.
  if (item.data.kind === 'record' && item.data.recordType === 'personnel') {
    try {
      const openalexResult = await tryOpenAlexMatch(item);
      if (openalexResult) return openalexResult;
    } catch (e: unknown) {
      console.warn(
        `[sourcing] OpenAlex matching failed for ${item.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
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
          verdict: 'unverifiable' as SourcingVerdict,
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

  // ── Relevance gate (QUA-426) ────────────────────────────────────────
  // If the source content doesn't even mention the record's subject, skip
  // the LLM call and record a `not_applicable` verdict. This catches the
  // "personnel record pointed at the org homepage" case where the LLM would
  // otherwise return `unverifiable 0.95` and pollute the record's rollup.
  //
  // Gated behind RELEVANCE_GATE_ENABLED to allow a fast rollback if the
  // false-negative rate is unexpectedly high in the real corpus.
  if (item.data.kind === 'record' && isRelevanceGateEnabled()) {
    const gate = runRelevanceGate(item.data, sourceContent);
    if (!gate.passed) {
      return {
        itemId: item.id,
        kind: item.kind,
        description: item.description,
        verdict: 'not_applicable' as SourcingVerdict,
        confidence: 1.0,
        extractedValue: '',
        reasoning: `[relevance_gate] ${gate.reason}`,
        sourceUrl: verifiedSourceUrl,
        checkerModel: 'relevance-gate',
        // QUA-791: explicit zero so aggregation drops this row even if
        // the not_applicable filter is later relaxed. Belt + suspenders.
        relevanceScore: 0,
      };
    }
  }

  // Build the appropriate prompt
  let prompt: string;
  switch (item.data.kind) {
    case 'fact':
      prompt = buildFactSourcingPrompt(item.data, sourceContent);
      break;
    case 'record':
      prompt = buildRecordSourcingPrompt(item.data, item.description, sourceContent);
      break;
    case 'entity':
      prompt = buildEntitySourcingPrompt(item.data.entity, sourceContent, verifiedSourceUrl);
      break;
  }

  try {
    const llmResult = await callLlmForSourcing(client, prompt, `verify-${item.id}`);

    return {
      itemId: item.id,
      kind: item.kind,
      description: item.description,
      verdict: llmResult.verdict as SourcingVerdict,
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
  // PR #4020 hardening: storeSourcingEvidence now throws on failure (was
  // silently log-and-resolve). We must NOT let an evidence-storage throw skip
  // the subsequent storeAggregateVerdict call — operators rely on the
  // aggregate verdicts table to display the most recent check result, and
  // dropping it would silently revert the displayed verdict to whatever stale
  // state existed before. Catch evidence errors locally, attempt the aggregate
  // verdict regardless, then re-throw the first error so the caller still
  // surfaces the failure (via the existing .catch in orchestrator.ts etc.).
  let firstError: unknown = null;

  if (item.data.kind === 'fact') {
    const factId = (item.data as FactItemData).fact.id;

    try {
      await storeSourcingEvidence({
        recordType: 'fact',
        recordId: factId,
        sourceUrl: result.sourceUrl,
        verdict: result.verdict,
        confidence: result.confidence,
        extractedValue: result.extractedValue,
        reasoning: result.reasoning,
        isPrimarySource: true,
        checkerModel: result.checkerModel,
        relevanceScore: result.relevanceScore ?? null,
      }, '[sourcing]');
    } catch (e: unknown) {
      firstError = e;
    }

    // Store aggregate verdict for facts too — ensures the most recent
    // check result is reflected in the verdicts table, fixing stale
    // contradictions that persisted after re-checks confirmed data.
    try {
      await storeAggregateVerdict({
        recordType: 'fact',
        recordId: factId,
        verdict: result.verdict,
        confidence: result.confidence,
        reasoning: result.reasoning,
        sourcesChecked: 1,
      }, '[sourcing]');
    } catch (e: unknown) {
      if (firstError === null) firstError = e;
    }
  } else if (item.data.kind === 'record') {
    const recordData = item.data as RecordItemData;

    try {
      await storeSourcingEvidence({
        recordType: recordData.recordType,
        recordId: recordData.recordId,
        sourceUrl: result.sourceUrl,
        verdict: result.verdict,
        confidence: result.confidence,
        extractedValue: result.extractedValue,
        reasoning: result.reasoning,
        entityId: recordData.entityId,
        checkerModel: result.checkerModel,
        relevanceScore: result.relevanceScore ?? null,
      }, '[sourcing]');
    } catch (e: unknown) {
      firstError = e;
    }

    try {
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
      }, '[sourcing]');
    } catch (e: unknown) {
      if (firstError === null) firstError = e;
    }
  }
  // Entity-type sourcing are logged but not stored in a specific endpoint
  // since they are discovery-based (web search) rather than source-based.

  if (firstError !== null) throw firstError;
}

// Re-export MODELS so orchestrator.ts can use it without importing from index
export { MODELS };
