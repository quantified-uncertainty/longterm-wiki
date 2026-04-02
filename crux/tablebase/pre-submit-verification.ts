/**
 * Pre-Submit Source Verification
 *
 * Verifies enrichment records against their source URLs before they are
 * submitted to the wiki-server. Catches hallucinated data (e.g., wrong roles,
 * fabricated affiliations) before it enters the database.
 *
 * Called inline by both:
 *   - handleSubmitRecords() in tools.ts (LLM agent path)
 *   - submitCommand() in commands/tablebase.ts (CLI path)
 *
 * Records that fail verification are excluded from submission with a warning.
 */

import { createLlmClient } from '../lib/llm.ts';
import {
  fetchSourceContent,
  callLlmForSourceCheck,
  SOURCE_CHECK_CONSTANTS,
} from '../lib/source-check/index.ts';
import {
  SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES,
  SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS,
  SOURCE_CHECK_RESPONSE_FORMAT,
} from '../lib/source-check/prompt-guidelines.ts';
import { buildStableIdNameMap } from './source-check.ts';

const { PROMPT_CONTENT_LENGTH } = SOURCE_CHECK_CONSTANTS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifiedRecord {
  record: Record<string, unknown>;
  /** Whether the record passed verification and should be submitted */
  passed: boolean;
  /** Verification details attached to the record */
  verification?: {
    verdict: string;
    confidence: number;
    reasoning: string;
  };
  /** Why the record was skipped (if passed === false) */
  skipReason?: string;
}

export interface PreSubmitResult {
  /** Records that passed verification (include in submission) */
  accepted: Array<Record<string, unknown>>;
  /** Records that failed verification (excluded from submission) */
  rejected: VerifiedRecord[];
  /** Records that were skipped (no source URL) — included without verification */
  noSource: Array<Record<string, unknown>>;
  /** Total verification cost in USD */
  cost: number;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build a source-check prompt for a personnel/enrichment record.
 * Resolves stableId fields to human-readable names for the LLM.
 */
function buildRecordCheckPrompt(
  table: string,
  record: Record<string, unknown>,
  sourceContent: string,
  nameMap: Map<string, string>,
): string {
  // Build a human-readable version of the record
  const humanized: Record<string, unknown> = { ...record };

  // Remove internal fields the LLM doesn't need
  const internalFields = ['id', 'syncedAt', 'createdAt', 'updatedAt', 'personEntityId', 'orgEntityId'];
  for (const field of internalFields) {
    delete humanized[field];
  }

  // Resolve stableId fields to names
  const entityFields = ['personId', 'organizationId', 'investorId', 'companyId', 'benchmarkId', 'modelId', 'granteeId'];
  for (const field of entityFields) {
    const val = humanized[field] as string | undefined;
    if (!val) continue;
    const name = nameMap.get(val);
    if (name) {
      humanized[field] = name;
    }
  }

  const fieldsStr = Object.entries(humanized)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');

  return `You are a fact-checker. Given the source text below, verify this ${table} record.

Record type: ${table}
Key fields:
${fieldsStr}

Source text (excerpt):
---
${sourceContent.slice(0, PROMPT_CONTENT_LENGTH)}
---

Does the source text confirm, contradict, or not address the claims in this record?

Focus especially on:
- Is the person's role/title correct according to the source?
- Is the person actually affiliated with this organization according to the source?
- Are dates plausible?

${SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES}

${SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS}

${SOURCE_CHECK_RESPONSE_FORMAT}`;
}

// ---------------------------------------------------------------------------
// Main verification function
// ---------------------------------------------------------------------------

/**
 * Verify enrichment records against their source URLs before submission.
 *
 * For each record with a source URL:
 *   1. Fetch cached source content from the citation_content cache
 *   2. Call the LLM source-checker (Haiku) to compare record vs source
 *   3. If verdict is "contradicted" or "unverifiable" with low confidence: reject
 *   4. Otherwise: accept with verification metadata attached
 *
 * Records without source URLs are included with a warning (some records
 * legitimately have no URL, e.g., manually confirmed data).
 *
 * @param table - Table name (e.g., "personnel")
 * @param records - Records to verify
 * @returns Categorized records: accepted, rejected, noSource
 */
export async function verifyBeforeSubmit(
  table: string,
  records: Array<Record<string, unknown>>,
): Promise<PreSubmitResult> {
  const accepted: Array<Record<string, unknown>> = [];
  const rejected: VerifiedRecord[] = [];
  const noSource: Array<Record<string, unknown>> = [];
  let totalCost = 0;

  // Build name map once for the batch
  const nameMap = buildStableIdNameMap();

  // Lazily create the LLM client only if we have records with sources
  let client: ReturnType<typeof createLlmClient> | null = null;

  for (const record of records) {
    const sourceUrl = (record.source as string) || (record.sourceUrl as string);

    // No source URL — include with a warning but don't block
    if (!sourceUrl) {
      console.warn(`[pre-verify] Record ${record.id ?? '?'}: no source URL — skipping verification`);
      noSource.push(record);
      continue;
    }

    // Fetch source content from cache
    const fetchResult = await fetchSourceContent(sourceUrl, undefined, '[pre-verify]');

    if (!fetchResult.content) {
      // Source content not available — include the record but log why
      const reason = fetchResult.errorMessage ?? fetchResult.errorType ?? 'unknown';
      console.warn(`[pre-verify] Record ${record.id ?? '?'}: source content unavailable (${reason}) — including without verification`);
      accepted.push(record);
      continue;
    }

    // Create LLM client on first use
    if (!client) {
      client = createLlmClient();
    }

    // Run LLM source-check
    const prompt = buildRecordCheckPrompt(table, record, fetchResult.content, nameMap);
    const label = `pre-verify-${table}-${record.id ?? 'unknown'}`;

    try {
      const result = await callLlmForSourceCheck(client, prompt, label);
      // Estimated cost for Haiku: ~$0.005 per call
      totalCost += 0.005;

      const verification = {
        verdict: result.verdict,
        confidence: result.confidence,
        reasoning: result.reasoning,
      };

      // Decision logic: reject contradicted or low-confidence unverifiable
      if (result.verdict === 'contradicted') {
        console.warn(
          `[pre-verify] REJECTED record ${record.id ?? '?'}: verdict=contradicted ` +
          `(confidence=${result.confidence.toFixed(2)}) — ${result.reasoning}`
        );
        rejected.push({
          record,
          passed: false,
          verification,
          skipReason: `Source contradicts record: ${result.reasoning}`,
        });
        continue;
      }

      if (result.verdict === 'unverifiable' && result.confidence < 0.3) {
        console.warn(
          `[pre-verify] REJECTED record ${record.id ?? '?'}: verdict=unverifiable ` +
          `with low confidence (${result.confidence.toFixed(2)}) — ${result.reasoning}`
        );
        rejected.push({
          record,
          passed: false,
          verification,
          skipReason: `Unverifiable with low confidence: ${result.reasoning}`,
        });
        continue;
      }

      // Record passed verification — attach verification data
      record.verification = verification;
      accepted.push(record);
    } catch (err: unknown) {
      // LLM call failed — include the record but log the error
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pre-verify] Record ${record.id ?? '?'}: verification failed (${msg}) — including without verification`);
      accepted.push(record);
    }
  }

  return { accepted, rejected, noSource, cost: totalCost };
}

/**
 * Format a human-readable summary of the pre-submit verification results.
 */
export function formatPreSubmitSummary(result: PreSubmitResult): string {
  const lines: string[] = [];
  const total = result.accepted.length + result.rejected.length + result.noSource.length;

  lines.push(`[pre-verify] Verification complete: ${total} records`);
  lines.push(`  Accepted: ${result.accepted.length}`);
  if (result.noSource.length > 0) {
    lines.push(`  No source (included): ${result.noSource.length}`);
  }
  if (result.rejected.length > 0) {
    lines.push(`  Rejected: ${result.rejected.length}`);
    for (const r of result.rejected) {
      const id = r.record.id ?? '?';
      const role = r.record.role ?? '';
      const person = r.record.personId ?? '';
      lines.push(`    - ${id}: ${person} / ${role} — ${r.skipReason}`);
    }
  }
  if (result.cost > 0) {
    lines.push(`  Verification cost: $${result.cost.toFixed(4)}`);
  }

  return lines.join('\n');
}
