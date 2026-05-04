/**
 * Source-Check Apply Suggestions — QUA-591
 *
 * Consume `approved` and `auto_verified` URL suggestions from the queue,
 * swap the evidence-row URL, re-run verification, and update the aggregate
 * verdict. Marks successful applies as status='applied' so re-runs are
 * naturally idempotent.
 *
 * Pipeline per suggestion:
 *   1. Fetch source content from the suggested URL (cache + Wayback fallback).
 *      - On cache miss, `fetchSourceContent` auto-enqueues a resource-ingest
 *        job; a second pass hours later will find the content cached. First
 *        passes of a sweep will therefore mostly leave suggestions alone —
 *        this is expected, not an error.
 *   2. LLM-verify the claim against the new content (same prompt as recheck).
 *   3. Store a new evidence row for the new URL.
 *   4. Store the aggregate verdict (replaces the prior `unverifiable`).
 *   5. PATCH the suggestion status to 'applied'.
 *
 * Usage:
 *   crux sourcing-apply-suggestions --dry-run                     Preview
 *   crux sourcing-apply-suggestions --limit=50 --budget=0.5       Apply up to 50
 *   crux sourcing-apply-suggestions --status=approved             Only human-approved
 *   crux sourcing-apply-suggestions --type=grant                   Filter by record type
 */

import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from '../lib/command-types.ts';
import {
  listUrlSuggestions,
  updateUrlSuggestionStatus,
  storeVerdict as storeVerdictRpc,
  getVerdictByRecord,
} from '../lib/wiki-server/sourcing-client.ts';
import {
  VALID_SUGGESTION_STATUSES,
  type SuggestionStatus,
} from '../../apps/wiki-server/src/routes/sourcing/url-suggestions.ts';
import { createLlmClient } from '../lib/llm.ts';
import {
  fetchSourceContent,
  callLlmForSourcing,
  storeSourcingEvidence,
  SOURCE_CHECK_CONSTANTS,
} from '../lib/sourcing/index.ts';
import { SOURCE_CHECK_RESPONSE_FORMAT } from '../lib/sourcing/prompt-guidelines.ts';
import type { SourcingVerdict } from '../../apps/wiki-server/src/api-types.ts';
import { truncate } from '../lib/text-utils.ts';

// ── Constants ────────────────────────────────────────────────────────

const { ESTIMATED_COST_PER_VERIFICATION } = SOURCE_CHECK_CONSTANTS;

const LOG_PREFIX = '[apply]';

const DEFAULT_STATUSES: SuggestionStatus[] = ['approved', 'auto_verified'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 2000;
const DEFAULT_BUDGET_USD = 0.50;
const PAGE_SIZE = 200;
/** Hard cap on pagination loops — see sourcing-recheck.ts for rationale. */
const MAX_PAGINATION_ITERATIONS = 100;

// verdict-priority-ok: recheck-day intervals, not a severity priority map.
/** Next-check-due intervals by verdict (in days) — mirrors sourcing-recheck. */
const RECHECK_INTERVALS: Record<string, number> = {
  confirmed: 90,
  contradicted: 7,
  outdated: 14,
  partial: 30,
  unverifiable: 60,
};

// ── Types ────────────────────────────────────────────────────────────

interface ApplyOptions extends BaseOptions {
  status?: string;
  type?: string;
  limit?: string;
  budget?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  ci?: boolean;
  json?: boolean;
}

interface PendingSuggestion {
  id: number;
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  suggestedUrl: string;
  title: string | null;
  snippet: string | null;
  sourceProvider: string;
  status: SuggestionStatus;
}

interface ApplyResult {
  id: number;
  recordType: string;
  recordId: string;
  suggestedUrl: string;
  previousVerdict: string;
  newVerdict: string;
  confidence: number;
  changed: boolean;
}

interface ApplyError {
  id: number;
  recordType: string;
  recordId: string;
  suggestedUrl: string;
  error: string;
  /** True when the URL isn't cached yet but an ingest job was enqueued —
   *  the operator can re-run in a few hours without further action. */
  awaitingIngest: boolean;
}

interface ApplySummary {
  totalCandidates: number;
  processed: number;
  applied: number;
  changed: number;
  errors: number;
  awaitingIngest: number;
  statusPatchErrors: number;
  estimatedCost: number;
  verdictTransitions: Array<{ from: string; to: string; count: number }>;
  results: ApplyResult[];
  failures: ApplyError[];
}

// ── Option parsing ───────────────────────────────────────────────────

function parseBoundedInt(
  raw: unknown,
  fallback: number,
  max: number,
  flag: string,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`warning: ignoring --${flag}=${raw} (expected positive integer)\n`);
    return fallback;
  }
  return Math.min(n, max);
}

function parsePositiveFloat(raw: unknown, fallback: number, flag: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`warning: ignoring --${flag}=${raw} (expected positive number)\n`);
    return fallback;
  }
  return n;
}

/**
 * Parse a comma-separated status filter. Validates each value against the
 * server-side enum. Invalid values cause the command to error out instead of
 * silently dropping — a typo like `--status=aproved` should not make the
 * command run on an empty set and report success.
 */
function parseStatusFilter(raw: unknown): SuggestionStatus[] | { error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return [...DEFAULT_STATUSES];
  }
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return [...DEFAULT_STATUSES];
  const allowed = new Set<string>(VALID_SUGGESTION_STATUSES);
  const out: SuggestionStatus[] = [];
  for (const p of parts) {
    if (!allowed.has(p)) {
      return { error: `Invalid --status "${p}". Must be one of: ${[...allowed].join(', ')}` };
    }
    out.push(p as SuggestionStatus);
  }
  return out;
}

// ── Candidate fetching ───────────────────────────────────────────────

/**
 * Fetch suggestions from the queue for each requested status, up to `limit`
 * total across all statuses. Paginates server-side (the server caps pages at
 * 200) and bails with a clear error if the server returns a malformed total.
 */
async function fetchCandidates(
  statuses: SuggestionStatus[],
  typeFilter: string | undefined,
  limit: number,
): Promise<{ candidates: PendingSuggestion[]; totalMatching: number } | { error: string }> {
  const collected: PendingSuggestion[] = [];
  let totalMatching = 0;

  for (const status of statuses) {
    if (collected.length >= limit) break;

    let offset = 0;
    let iterations = 0;
    while (collected.length < limit) {
      if (iterations++ >= MAX_PAGINATION_ITERATIONS) {
        return {
          error: `Pagination exceeded ${MAX_PAGINATION_ITERATIONS} iterations for status=${status} — server may be returning malformed pagination metadata.`,
        };
      }

      const pageSize = Math.min(PAGE_SIZE, limit - collected.length);
      const response = await listUrlSuggestions({
        recordType: typeFilter,
        status,
        limit: pageSize,
        offset,
      });
      if (!response.ok) {
        return { error: `Failed to list url-suggestions (status=${status}): ${response.message}` };
      }

      const rows = response.data.suggestions ?? [];
      // The list endpoint returns `returned` (page size) not a total count.
      // Accumulate as we go so the summary isn't a lie.
      totalMatching += rows.length;
      if (rows.length === 0) break;

      for (const r of rows) {
        collected.push({
          id: r.id,
          recordType: r.recordType,
          recordId: r.recordId,
          fieldName: r.fieldName ?? null,
          entityId: r.entityId ?? null,
          suggestedUrl: r.suggestedUrl,
          title: r.title ?? null,
          snippet: r.snippet ?? null,
          sourceProvider: r.sourceProvider,
          status: r.status as SuggestionStatus,
        });
      }
      offset += rows.length;
      if (rows.length < pageSize) break;
    }
  }

  return { candidates: collected.slice(0, limit), totalMatching };
}

// ── LLM verification ─────────────────────────────────────────────────

/**
 * Prompt modeled on sourcing-recheck. Does NOT include the prior verdict's
 * reasoning on purpose — we're verifying against a *new* URL, and the prior
 * reasoning was about the old URL. Including it would bias the model toward
 * the prior verdict ("confirm unverifiable because the old reasoning said so")
 * when we want a fresh read.
 */
function buildApplyPrompt(
  candidate: PendingSuggestion,
  sourceText: string,
): string {
  return `You are a fact-checker evaluating whether a newly-proposed source URL supports a previously-unverifiable record.

Record type: ${candidate.recordType}
Record ID: ${candidate.recordId}
${candidate.fieldName ? `Field: ${candidate.fieldName}` : ''}
${candidate.entityId ? `Entity: ${candidate.entityId}` : ''}

Suggested source URL: ${candidate.suggestedUrl}
${candidate.title ? `Source title: ${candidate.title}` : ''}

Source text (excerpt):
---
${sourceText.slice(0, SOURCE_CHECK_CONSTANTS.PROMPT_CONTENT_LENGTH)}
---

Evaluate whether this source supports the record:
- "confirmed": The source explicitly states the record's data.
- "partial": The source confirms some but not all fields.
- "contradicted": The source explicitly states a different value.
- "unverifiable": The source does not address the claim, or is off-topic.
- "outdated": The source confirms a historically-correct-but-now-stale value.

${SOURCE_CHECK_RESPONSE_FORMAT}`;
}

function computeNextCheckDue(verdict: string): string {
  const days = RECHECK_INTERVALS[verdict] ?? 60;
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

// ── Per-candidate apply ──────────────────────────────────────────────

async function applyOne(
  candidate: PendingSuggestion,
  client: ReturnType<typeof createLlmClient>,
): Promise<ApplyResult | ApplyError> {
  // Step 1: fetch the suggested URL's content.
  const fetchResult = await fetchSourceContent(
    candidate.suggestedUrl,
    undefined,
    LOG_PREFIX,
  );
  if (!fetchResult.content) {
    const awaitingIngest =
      fetchResult.errorType === 'not_cached' && Boolean(fetchResult.ingestEnqueued);
    return {
      id: candidate.id,
      recordType: candidate.recordType,
      recordId: candidate.recordId,
      suggestedUrl: candidate.suggestedUrl,
      error: fetchResult.errorMessage ?? 'Could not fetch source content',
      awaitingIngest,
    };
  }

  // Step 2: look up the current verdict so we can report the transition.
  let previousVerdict = 'unverifiable';
  try {
    const priorResp = await getVerdictByRecord(candidate.recordType, candidate.recordId);
    if (priorResp.ok) {
      const verdicts = priorResp.data.verdicts ?? [];
      // Prefer the row matching our fieldName (null == null or both strings).
      const match = verdicts.find(
        (v) => (v.fieldName ?? null) === (candidate.fieldName ?? null),
      ) ?? verdicts[0];
      if (match) previousVerdict = match.verdict;
    }
  } catch (e: unknown) {
    // Non-fatal — we'll report previousVerdict as 'unverifiable' (our best guess)
    console.warn(
      `${LOG_PREFIX} Could not fetch prior verdict for ${candidate.recordType}/${candidate.recordId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Step 3: LLM.
  let llmResult;
  try {
    const prompt = buildApplyPrompt(candidate, fetchResult.content);
    llmResult = await callLlmForSourcing(
      client,
      prompt,
      `apply-${candidate.recordType}-${candidate.recordId}`,
    );
  } catch (e: unknown) {
    return {
      id: candidate.id,
      recordType: candidate.recordType,
      recordId: candidate.recordId,
      suggestedUrl: candidate.suggestedUrl,
      error: `LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
      awaitingIngest: false,
    };
  }

  const newVerdict = llmResult.verdict as SourcingVerdict;
  const changed = newVerdict !== previousVerdict;

  // Step 4: persist evidence + aggregate verdict.
  try {
    await storeSourcingEvidence(
      {
        recordType: candidate.recordType as Parameters<typeof storeSourcingEvidence>[0]['recordType'],
        recordId: candidate.recordId,
        sourceUrl: candidate.suggestedUrl,
        verdict: newVerdict,
        confidence: llmResult.confidence,
        extractedValue: llmResult.extractedValue ?? '',
        reasoning: `Apply URL suggestion #${candidate.id}. ${llmResult.reasoning ?? ''}`,
        entityId: candidate.entityId,
        fieldName: candidate.fieldName,
      },
      LOG_PREFIX,
    );
  } catch (e: unknown) {
    return {
      id: candidate.id,
      recordType: candidate.recordType,
      recordId: candidate.recordId,
      suggestedUrl: candidate.suggestedUrl,
      error: `Evidence storage failed: ${e instanceof Error ? e.message : String(e)}`,
      awaitingIngest: false,
    };
  }

  const verdictBody: Record<string, unknown> = {
    recordType: candidate.recordType,
    recordId: candidate.recordId,
    verdict: newVerdict,
    confidence: llmResult.confidence,
    reasoning: `Applied URL suggestion #${candidate.id}. Prior: ${previousVerdict}. ${changed ? 'Changed.' : 'Unchanged.'}`,
    sourcesChecked: 1,
    nextCheckDue: computeNextCheckDue(newVerdict),
  };
  // Carry fieldName through when present so we don't accidentally demote
  // a field-level verdict into a row-level one (sourcing-recheck.ts has the
  // same risk but we do it right here).
  if (candidate.fieldName != null) verdictBody.fieldName = candidate.fieldName;
  if (candidate.entityId != null) verdictBody.entityId = candidate.entityId;

  const verdictResp = await storeVerdictRpc(verdictBody);
  if (!verdictResp.ok) {
    return {
      id: candidate.id,
      recordType: candidate.recordType,
      recordId: candidate.recordId,
      suggestedUrl: candidate.suggestedUrl,
      error: `Verdict storage failed: ${verdictResp.error ?? verdictResp.message ?? 'unknown'}`,
      awaitingIngest: false,
    };
  }

  return {
    id: candidate.id,
    recordType: candidate.recordType,
    recordId: candidate.recordId,
    suggestedUrl: candidate.suggestedUrl,
    previousVerdict,
    newVerdict,
    confidence: llmResult.confidence,
    changed,
  };
}

// ── Main command ─────────────────────────────────────────────────────

async function applyCommand(
  _args: string[],
  options: ApplyOptions,
): Promise<CommandResult> {
  const isDryRun = options['dry-run'] || options.dryRun;
  const statusParse = parseStatusFilter(options.status);
  if ('error' in statusParse) {
    return { exitCode: 1, output: statusParse.error };
  }
  const statuses = statusParse;
  const typeFilter = options.type as string | undefined;
  const limit = parseBoundedInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT, 'limit');
  const budget = parsePositiveFloat(options.budget, DEFAULT_BUDGET_USD, 'budget');

  console.log('\x1b[1mSource-Check Apply Suggestions\x1b[0m');
  console.log(`Statuses: ${statuses.join(', ')}${typeFilter ? ` | type=${typeFilter}` : ''}`);
  console.log('');

  // ── Step 1: fetch candidates ──
  console.log('Fetching candidate suggestions...');
  const candidatesResult = await fetchCandidates(statuses, typeFilter, limit);
  if ('error' in candidatesResult) {
    return { exitCode: 1, output: candidatesResult.error };
  }
  const { candidates } = candidatesResult;

  if (candidates.length === 0) {
    return {
      exitCode: 0,
      output: `No suggestions found with status in {${statuses.join(', ')}}${typeFilter ? ` and recordType=${typeFilter}` : ''}.`,
    };
  }

  console.log(`  Found ${candidates.length} candidate(s) (limit=${limit})`);

  // ── Step 2: budget cap ──
  const maxByBudget = Math.floor(budget / ESTIMATED_COST_PER_VERIFICATION);
  const toApply = candidates.slice(0, maxByBudget);
  const estimatedCost = toApply.length * ESTIMATED_COST_PER_VERIFICATION;

  if (maxByBudget < candidates.length) {
    console.log(`  Budget \$${budget.toFixed(2)} caps at ${maxByBudget} apply(s) (est. cost \$${estimatedCost.toFixed(2)})`);
  }

  // ── Step 3: dry run ──
  if (isDryRun) {
    return formatDryRunOutput(toApply, candidates.length, estimatedCost, options);
  }

  // ── Live execution ──
  const client = createLlmClient();
  const summary: ApplySummary = {
    totalCandidates: candidates.length,
    processed: 0,
    applied: 0,
    changed: 0,
    errors: 0,
    awaitingIngest: 0,
    statusPatchErrors: 0,
    estimatedCost,
    verdictTransitions: [],
    results: [],
    failures: [],
  };
  const transitionCounts = new Map<string, number>();

  console.log(`\n\x1b[1mApplying ${toApply.length} suggestions (est. \$${estimatedCost.toFixed(2)})...\x1b[0m\n`);

  for (let i = 0; i < toApply.length; i++) {
    const candidate = toApply[i];
    const label = `${candidate.recordType}/${candidate.recordId}`.slice(0, 60);
    const urlShort = truncate(candidate.suggestedUrl, 80, { ellipsis: '...' });
    console.log(`  [${i + 1}/${toApply.length}] ${label} → ${urlShort}`);

    summary.processed++;
    const result = await applyOne(candidate, client);

    if ('error' in result) {
      summary.errors++;
      if (result.awaitingIngest) summary.awaitingIngest++;
      summary.failures.push(result);
      const prefix = result.awaitingIngest ? '    \x1b[33mAWAITING INGEST' : '    \x1b[31mERROR';
      console.log(`${prefix}: ${result.error}\x1b[0m`);
      continue;
    }

    summary.applied++;
    summary.results.push(result);

    if (result.changed) summary.changed++;
    const transitionKey = `${result.previousVerdict}→${result.newVerdict}`;
    transitionCounts.set(transitionKey, (transitionCounts.get(transitionKey) ?? 0) + 1);

    const color = result.newVerdict === 'confirmed' ? '\x1b[32m'
      : result.newVerdict === 'contradicted' ? '\x1b[31m'
      : '\x1b[33m';
    const changeMarker = result.changed ? ' [CHANGED]' : '';
    console.log(`    ${color}${result.previousVerdict} → ${result.newVerdict}\x1b[0m (confidence: ${(result.confidence * 100).toFixed(0)}%)${changeMarker}`);

    // Mark the suggestion as applied. A status-patch failure must not drop
    // the apply — the evidence and verdict are already stored, so next run
    // would just re-do the LLM. We log but continue.
    try {
      const patchResp = await updateUrlSuggestionStatus(candidate.id, {
        status: 'applied',
        reviewedBy: 'sourcing-apply-suggestions',
      });
      if (!patchResp.ok) {
        summary.statusPatchErrors++;
        console.warn(`    \x1b[33mFailed to mark suggestion ${candidate.id} as applied: ${patchResp.message ?? 'unknown'}\x1b[0m`);
      }
    } catch (e: unknown) {
      summary.statusPatchErrors++;
      console.warn(`    \x1b[33mFailed to mark suggestion ${candidate.id} as applied: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
    }
  }

  // Roll up transitions.
  summary.verdictTransitions = [...transitionCounts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('→');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  // ── Exit code ──
  // Non-zero on any error so CI / scripts catch partial failure. Note: the
  // `awaiting ingest` path is NOT an error in the usual sense — it just means
  // the second pass hasn't been run yet — but it contributes to `errors`
  // because the caller should know the sweep isn't fully converged.
  const exitCode = summary.errors > 0 || summary.statusPatchErrors > 0 ? 1 : 0;

  if (options.ci || options.json) {
    return { exitCode, output: JSON.stringify(summary) };
  }
  return { exitCode, output: formatSummaryOutput(summary) };
}

// ── Output formatting ────────────────────────────────────────────────

function formatDryRunOutput(
  items: PendingSuggestion[],
  totalCandidates: number,
  estimatedCost: number,
  options: ApplyOptions,
): CommandResult {
  if (options.ci || options.json) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        totalCandidates,
        selected: items.length,
        estimatedCost,
        items: items.map((i) => ({
          id: i.id,
          recordType: i.recordType,
          recordId: i.recordId,
          fieldName: i.fieldName,
          suggestedUrl: i.suggestedUrl,
          sourceProvider: i.sourceProvider,
          status: i.status,
        })),
      }),
    };
  }

  const lines: string[] = [];
  lines.push(`\x1b[1mDry run: ${items.length} of ${totalCandidates} suggestions would be applied\x1b[0m`);
  lines.push(`Estimated cost: \$${estimatedCost.toFixed(2)}`);
  lines.push('');

  const byType = new Map<string, number>();
  for (const item of items) {
    byType.set(item.recordType, (byType.get(item.recordType) ?? 0) + 1);
  }
  lines.push('\x1b[1mBy record type:\x1b[0m');
  for (const [type, cnt] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${type.padEnd(20)} ${cnt}`);
  }
  lines.push('');

  const byProvider = new Map<string, number>();
  for (const item of items) {
    byProvider.set(item.sourceProvider, (byProvider.get(item.sourceProvider) ?? 0) + 1);
  }
  lines.push('\x1b[1mBy source provider:\x1b[0m');
  for (const [provider, cnt] of [...byProvider.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${provider.padEnd(15)} ${cnt}`);
  }
  lines.push('');

  const header = `${'ID'.padEnd(8)} ${'Type'.padEnd(16)} ${'Record'.padEnd(30)} ${'Status'.padEnd(14)} URL`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(120));
  for (const item of items.slice(0, 30)) {
    const rid = truncate(item.recordId, 30, { ellipsis: '...' });
    const url = truncate(item.suggestedUrl, 50, { ellipsis: '...' });
    lines.push(
      `${String(item.id).padEnd(8)} ${item.recordType.padEnd(16)} ${rid.padEnd(30)} ${item.status.padEnd(14)} ${url}`,
    );
  }
  if (items.length > 30) {
    lines.push(`  ... and ${items.length - 30} more`);
  }

  lines.push('');
  lines.push('Use without --dry-run to apply (calls LLM against each suggested URL).');

  return { exitCode: 0, output: lines.join('\n') };
}

function formatSummaryOutput(summary: ApplySummary): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[1m=== Apply-Suggestions Summary ===\x1b[0m');
  lines.push(`Candidates:        ${summary.totalCandidates}`);
  lines.push(`Processed:         ${summary.processed}`);
  lines.push(`Applied:           ${summary.applied}`);
  lines.push(`Changed verdicts:  ${summary.changed}`);
  lines.push(`Errors:            ${summary.errors}`);
  if (summary.awaitingIngest > 0) {
    lines.push(`  \x1b[33m(${summary.awaitingIngest} awaiting resource-ingest — re-run in a few hours)\x1b[0m`);
  }
  if (summary.statusPatchErrors > 0) {
    lines.push(`  \x1b[33m${summary.statusPatchErrors} suggestion(s) applied but not marked as 'applied' — next run will re-apply\x1b[0m`);
  }
  lines.push(`Est. cost:         \$${summary.estimatedCost.toFixed(2)}`);
  lines.push('');

  if (summary.verdictTransitions.length > 0) {
    lines.push('\x1b[1mVerdict transitions:\x1b[0m');
    for (const t of summary.verdictTransitions) {
      const color = t.to === 'confirmed' ? '\x1b[32m'
        : t.to === 'contradicted' ? '\x1b[31m'
        : '\x1b[33m';
      lines.push(`  ${t.from.padEnd(15)} → ${color}${t.to.padEnd(15)}\x1b[0m ${t.count}`);
    }
    lines.push('');
  }

  if (summary.failures.length > 0) {
    lines.push(`\x1b[31mErrors (${summary.failures.length}):\x1b[0m`);
    for (const f of summary.failures.slice(0, 10)) {
      const tag = f.awaitingIngest ? '[awaiting-ingest] ' : '';
      lines.push(`  ${tag}${f.recordType}/${f.recordId}: ${f.error}`);
    }
    if (summary.failures.length > 10) {
      lines.push(`  ... and ${summary.failures.length - 10} more`);
    }
  }

  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: applyCommand,
};

export function getHelp(): string {
  return `
Source-Check Apply Suggestions — consume approved URL suggestions

Usage:
  crux sourcing-apply-suggestions [options]

Options:
  --status=X,Y        Comma-separated statuses to consume (default: approved,auto_verified).
                      Valid: ${VALID_SUGGESTION_STATUSES.join(' | ')}
  --type=X            Filter by record type (e.g., grant, personnel, fact)
  --limit=N           Max suggestions to apply (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})
  --budget=N          Max dollars to spend on LLM rechecks (default: \$${DEFAULT_BUDGET_USD.toFixed(2)},
                      est. ~\$${ESTIMATED_COST_PER_VERIFICATION.toFixed(2)}/apply)
  --dry-run           Preview what would be applied without fetching or LLM calls
  --ci / --json       Machine-readable JSON output

What it does:
  For each suggestion in {status, status, …}:
    1. Fetch source content from the suggested URL (cache + Wayback fallback).
    2. LLM-verify the claim against the new content.
    3. Store a new evidence row + update the aggregate verdict.
    4. Mark the suggestion as 'applied' so re-runs are idempotent.

  Brand-new suggestion URLs will usually miss the cache on the first pass.
  fetchSourceContent auto-enqueues a resource-ingest job in that case and the
  suggestion stays in its original status — re-run the command after the
  ingest worker catches up (usually minutes to a few hours).

Requires WIKI_SERVER_ENV=prod in agent slots (no local wiki-server).
`.trim();
}
