/**
 * Source-Check Recheck Scheduler
 *
 * Queries items due for re-check (next_check_due <= NOW or needs_recheck = true)
 * and re-runs the sourcing pipeline on them. Prioritizes by verdict severity:
 * contradicted > outdated > partial > unverifiable > confirmed.
 *
 * Usage:
 *   crux sourcing-recheck --dry-run                 Preview what would be rechecked
 *   crux sourcing-recheck --budget=1 --limit=50     Recheck up to 50 items, $1 budget
 *   crux sourcing-recheck --type=personnel           Filter by record type
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  storeVerdict as storeVerdictRpc,
  getDueForRecheck,
  listVerdicts,
  getEvidenceByRecords,
  evidenceRecordKey,
} from '../lib/wiki-server/sourcing-client.ts';
import { createLlmClient } from '../lib/llm.ts';
import {
  fetchSourceContent,
  callLlmForSourcing,
  storeSourcingEvidence,
  storeAggregateVerdict,
  SOURCE_CHECK_CONSTANTS,
} from '../lib/sourcing/index.ts';
import { SOURCE_CHECK_RESPONSE_FORMAT } from '../lib/sourcing/prompt-guidelines.ts';
import { truncate } from '../lib/text-utils.ts';
import type { SourcingVerdict } from '../../apps/wiki-server/src/api-types.ts';
import { extractQid } from '../lib/sourcing/wikidata-matcher.ts';

// ── Constants ────────────────────────────────────────────────────────

const { ESTIMATED_COST_PER_VERIFICATION } = SOURCE_CHECK_CONSTANTS;

const LOG_PREFIX = '[recheck]';

// verdict-priority-ok: recheck-day intervals, not a severity priority map.
/** Next-check-due intervals by verdict (in days) */
const RECHECK_INTERVALS: Record<string, number> = {
  confirmed: 90,
  contradicted: 7,
  outdated: 14,
  partial: 30,
  unverifiable: 60,
};

// ── Types ────────────────────────────────────────────────────────────

interface RecheckOptions extends BaseOptions {
  budget?: string;
  limit?: string;
  type?: string;
  verdict?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  ci?: boolean;
}

// verdict-priority-ok: recheck scheduling weights (higher = recheck sooner).
// Same severity intent as canonical SOURCE_CHECK_VERDICT_PRIORITY but uses
// 0-100 weights instead of 0-5 priorities for budget allocation. Keep in sync
// with canonical order if either changes.
const VERDICT_PRIORITY: Record<string, number> = {
  contradicted: 100,
  outdated: 80,
  partial: 50,
  unverifiable: 30,
  confirmed: 10,
};

const ALLOWED_FORCE_VERDICTS = new Set(Object.keys(VERDICT_PRIORITY));

interface DueItem {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number;
  needsRecheck: boolean;
  nextCheckDue: string | null;
  lastComputedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  priority: number;
}

interface RecheckResult {
  recordType: string;
  recordId: string;
  previousVerdict: string;
  newVerdict: string;
  confidence: number;
  changed: boolean;
  sourceUrl: string;
}

interface RecheckError {
  recordType: string;
  recordId: string;
  error: string;
}

interface RecheckSummary {
  totalDue: number;
  rechecked: number;
  changed: number;
  errors: number;
  /**
   * Number of items where the recheck verdict was computed but the storage
   * call failed. The verdict was lost — re-run after the underlying issue is
   * fixed. Drives a non-zero exit code. Issue #4017.
   */
  storageErrors: number;
  estimatedCost: number;
  verdictChanges: Array<{ recordType: string; recordId: string; from: string; to: string }>;
  byVerdict: Record<string, number>;
  results: RecheckResult[];
  failures: RecheckError[];
}

// ── Source URL resolution ────────────────────────────────────────────

/**
 * QUA-331: batch-fetch source URLs for a list of due items in a single
 * HTTP call. Returns a map keyed by `recordType|recordId`. Missing keys
 * mean no evidence row carried a `sourceUrl` (or the record was absent
 * from the evidence table) — the caller treats that as "no URL".
 *
 * Throws on HTTP failure so the caller aborts the whole scan. The old
 * per-record path swallowed errors and returned null per item; with a
 * batch call, swallowing would turn a single network blip into "every
 * record has no URL" for the entire scan, which is indistinguishable
 * from a real data shortage. Better to fail loudly.
 */
async function fetchSourceUrls(items: DueItem[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (items.length === 0) return result;

  const response = await getEvidenceByRecords(
    items.map((i) => ({ recordType: i.recordType, recordId: i.recordId })),
    { limitPerRecord: 5 },
  );
  if (!response.ok) {
    throw new Error(
      `Batch evidence fetch failed: ${response.message ?? 'unknown error'}`,
    );
  }

  for (const [key, rows] of Object.entries(response.data.evidenceByKey)) {
    const firstUrl = rows.find((e) => e.sourceUrl)?.sourceUrl;
    if (firstUrl) result.set(key, firstUrl);
  }
  return result;
}

// ── LLM re-check ─────────────────────────────────────────────

function buildRecheckPrompt(item: DueItem, sourceText: string): string {
  const previousVerdict = item.verdict;
  const previousReasoning = item.reasoning ?? 'No previous reasoning available';

  return `You are a fact-checker performing a re-check of a previously checked record.

Record type: ${item.recordType}
Record ID: ${item.recordId}
${item.entityId ? `Entity: ${item.entityId}` : ''}

Previous verdict: ${previousVerdict}
Previous reasoning: ${previousReasoning}

Source text (excerpt):
---
${sourceText.slice(0, SOURCE_CHECK_CONSTANTS.PROMPT_CONTENT_LENGTH)}
---

Re-verify this record against the source text. Has anything changed since the last check?
Consider:
- If the source now confirms the data, upgrade to "confirmed"
- If the source has been updated with newer information, mark as "outdated"
- If the source now contradicts what we have, mark as "contradicted"
- If the source partially matches, mark as "partial"
- If the source no longer addresses this data point, mark as "unverifiable"

${SOURCE_CHECK_RESPONSE_FORMAT}

In addition to the guidance above, since this is a re-check, the \`reasoning\` field should briefly note whether the verdict changed from the previous check.`;
}

/**
 * Re-verify a single item by fetching its source and running LLM check.
 */
async function recheckSingleItem(
  item: DueItem,
  client: ReturnType<typeof createLlmClient>,
  sourceUrl: string | null,
): Promise<RecheckResult | RecheckError> {
  // Step 1: Source URL already resolved via the batch pre-fetch
  if (!sourceUrl) {
    return {
      recordType: item.recordType,
      recordId: item.recordId,
      error: 'No source URL found in evidence history',
    };
  }

  // Step 1b: Skip LLM for Wikidata-sourced facts (QUA-92)
  // Facts with Wikidata sources are verified deterministically by tryWikidataMatch()
  // in the primary pipeline. Re-running them through LLM causes verdict flip-flopping
  // because the LLM inconsistently reads Wikidata HTML. Instead, preserve the existing
  // verdict and extend the recheck interval.
  if (item.recordType === 'fact' && extractQid(sourceUrl)) {
    return {
      recordType: item.recordType,
      recordId: item.recordId,
      previousVerdict: item.verdict,
      newVerdict: item.verdict,
      confidence: item.confidence ?? 0.95,
      changed: false,
      sourceUrl,
    };
  }

  // Step 2: Fetch source content
  const fetchResult = await fetchSourceContent(sourceUrl);
  if (!fetchResult.content) {
    return {
      recordType: item.recordType,
      recordId: item.recordId,
      error: fetchResult.errorMessage ?? 'Could not fetch source content',
    };
  }

  // Step 3: LLM sourcing
  try {
    const prompt = buildRecheckPrompt(item, fetchResult.content);
    const llmResult = await callLlmForSourcing(
      client,
      prompt,
      `recheck-${item.recordType}-${item.recordId}`,
    );

    const newVerdict = llmResult.verdict as SourcingVerdict;
    const changed = newVerdict !== item.verdict;

    return {
      recordType: item.recordType,
      recordId: item.recordId,
      previousVerdict: item.verdict,
      newVerdict,
      confidence: llmResult.confidence,
      changed,
      sourceUrl,
    };
  } catch (e: unknown) {
    return {
      recordType: item.recordType,
      recordId: item.recordId,
      error: `LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Result storage ───────────────────────────────────────────────────

function computeNextCheckDue(verdict: string): string {
  const days = RECHECK_INTERVALS[verdict] ?? 60;
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

async function storeRecheckResult(result: RecheckResult): Promise<void> {
  // Store evidence
  await storeSourcingEvidence({
    recordType: result.recordType as Parameters<typeof storeSourcingEvidence>[0]['recordType'],
    recordId: result.recordId,
    sourceUrl: result.sourceUrl,
    verdict: result.newVerdict,
    confidence: result.confidence,
    extractedValue: `Recheck: ${result.previousVerdict} -> ${result.newVerdict}`,
    reasoning: `Re-check. Previous verdict: ${result.previousVerdict}. ${result.changed ? 'Verdict changed.' : 'Verdict unchanged.'}`,
  }, LOG_PREFIX);

  // Update aggregate verdict with new nextCheckDue
  const nextCheckDue = computeNextCheckDue(result.newVerdict);

  const body = {
    recordType: result.recordType,
    recordId: result.recordId,
    verdict: result.newVerdict,
    confidence: result.confidence,
    reasoning: `Re-check. Previous: ${result.previousVerdict}. ${result.changed ? 'Changed.' : 'Unchanged.'}`,
    sourcesChecked: 1,
    nextCheckDue,
  };

  const response = await storeVerdictRpc(body);

  if (!response.ok) {
    console.warn(`${LOG_PREFIX} Failed to store verdict for ${result.recordType}/${result.recordId}: ${response.error}`);
  }
}

// ── Main command ─────────────────────────────────────────────────────

async function recheckCommand(
  args: string[],
  options: RecheckOptions,
): Promise<CommandResult> {
  const isDryRun = options['dry-run'] || options.dryRun;
  const budgetLimit = options.budget ? parseFloat(String(options.budget)) : 1.0;
  const itemLimit = options.limit ? parseInt(String(options.limit), 10) : 50;
  const typeFilter = options.type as string | undefined;
  const verdictFilter = options.verdict as string | undefined;

  if (verdictFilter && !ALLOWED_FORCE_VERDICTS.has(verdictFilter)) {
    return {
      exitCode: 1,
      output: `Invalid --verdict "${verdictFilter}". Must be one of: ${[...ALLOWED_FORCE_VERDICTS].join(', ')}`,
    };
  }

  console.log('\x1b[1mSource-Check Recheck Scheduler\x1b[0m');
  console.log('');

  // ── Step 1: Fetch items ──
  // When --verdict is passed, bypass the due-date filter and pull all verdicts
  // matching that type. Used for targeted sweeps (QUA-546) where we want to
  // re-run the improved LLM prompt against historical verdicts regardless of
  // whether their nextCheckDue has elapsed.
  let items: DueItem[];
  let total: number;

  if (verdictFilter) {
    console.log(`Fetching verdicts with verdict='${verdictFilter}' (bypassing due-date filter)...`);
    // Server clamps per-page to MAX_PAGE_SIZE (200), so paginate client-side
    // until we have `itemLimit` items or the server runs out. Without this,
    // a large --limit silently returns only the first 200 and subsequent
    // rows never get processed.
    const PAGE_SIZE = 200;
    const MAX_ITERATIONS = 100; // Hard cap on pagination loops — with PAGE_SIZE=200, this is up to 20k rows. If we hit this, something's wrong upstream (server returning stale pages, total field undefined, etc.) — better to fail loud than hang.
    const priority = VERDICT_PRIORITY[verdictFilter];
    const collected: DueItem[] = [];
    let serverTotal = 0;
    let offset = 0;
    let iterations = 0;
    while (collected.length < itemLimit) {
      if (iterations++ >= MAX_ITERATIONS) {
        return {
          exitCode: 1,
          output: `Pagination exceeded ${MAX_ITERATIONS} iterations — server may be returning malformed pagination metadata.`,
        };
      }
      const pageSize = Math.min(PAGE_SIZE, itemLimit - collected.length);
      const response = await listVerdicts({
        verdict: verdictFilter,
        recordType: typeFilter,
        limit: pageSize,
        offset,
      });
      if (!response.ok) {
        return {
          exitCode: 1,
          output: `Failed to list verdicts: ${response.message}`,
        };
      }
      serverTotal = response.data.total;
      const rows = response.data.verdicts;
      if (rows.length === 0) break;
      for (const v of rows) {
        collected.push({
          recordType: v.recordType,
          recordId: v.recordId,
          fieldName: v.fieldName,
          entityId: v.entityId,
          verdict: v.verdict,
          confidence: v.confidence,
          reasoning: v.reasoning,
          sourcesChecked: v.sourcesChecked,
          needsRecheck: v.needsRecheck,
          nextCheckDue: v.nextCheckDue,
          lastComputedAt: v.lastComputedAt,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
          priority,
        });
      }
      offset += rows.length;
      if (offset >= serverTotal) break;
    }
    items = collected;
    total = serverTotal;
  } else {
    console.log('Fetching items due for recheck...');
    const response = await getDueForRecheck({ recordType: typeFilter, limit: itemLimit });
    if (!response.ok) {
      return {
        exitCode: 1,
        output: `Failed to fetch items due for recheck: ${response.message}`,
      };
    }
    items = response.data.items;
    total = response.data.total;
  }

  if (items.length === 0) {
    return {
      exitCode: 0,
      output: verdictFilter
        ? `No verdicts matched verdict='${verdictFilter}'${typeFilter ? ` type='${typeFilter}'` : ''}.`
        : 'No items due for recheck.',
    };
  }

  console.log(`  Found ${items.length} item(s)${verdictFilter ? '' : ' due for recheck'} (${total} total matching)`);

  // ── Step 2: Apply budget cap ──
  const maxByBudget = Math.floor(budgetLimit / ESTIMATED_COST_PER_VERIFICATION);
  let itemsToRecheck = items;
  if (maxByBudget < itemsToRecheck.length) {
    itemsToRecheck = itemsToRecheck.slice(0, maxByBudget);
  }

  const estimatedCost = itemsToRecheck.length * ESTIMATED_COST_PER_VERIFICATION;

  // ── Step 3: Dry run or execute ──
  if (isDryRun) {
    return formatDryRunOutput(itemsToRecheck, total, estimatedCost, options);
  }

  // ── Live execution ──
  const client = createLlmClient();
  const summary: RecheckSummary = {
    totalDue: total,
    rechecked: 0,
    changed: 0,
    errors: 0,
    storageErrors: 0,
    estimatedCost,
    verdictChanges: [],
    byVerdict: {},
    results: [],
    failures: [],
  };

  console.log(`\n\x1b[1mRechecking ${itemsToRecheck.length} items (est. \$${estimatedCost.toFixed(2)})...\x1b[0m\n`);

  // QUA-331: pre-fetch every source URL in one batch call rather than
  // one-per-item inside the loop. Abort on failure — see `fetchSourceUrls`
  // docstring for why swallowing here would mask real data shortages.
  let sourceUrlsByKey: Map<string, string>;
  try {
    sourceUrlsByKey = await fetchSourceUrls(itemsToRecheck);
  } catch (e: unknown) {
    return {
      exitCode: 1,
      output: `${LOG_PREFIX} ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  for (let i = 0; i < itemsToRecheck.length; i++) {
    const item = itemsToRecheck[i];
    const label = `${item.recordType}/${item.recordId}`.slice(0, 60);
    console.log(`  [${i + 1}/${itemsToRecheck.length}] ${label} (was: ${item.verdict})`);

    const sourceUrl = sourceUrlsByKey.get(evidenceRecordKey(item.recordType, item.recordId)) ?? null;
    const result = await recheckSingleItem(item, client, sourceUrl);

    if ('error' in result) {
      summary.errors++;
      summary.failures.push(result);
      console.log(`    \x1b[31mERROR: ${result.error}\x1b[0m`);
    } else {
      summary.rechecked++;
      summary.byVerdict[result.newVerdict] = (summary.byVerdict[result.newVerdict] ?? 0) + 1;
      summary.results.push(result);

      if (result.changed) {
        summary.changed++;
        summary.verdictChanges.push({
          recordType: result.recordType,
          recordId: result.recordId,
          from: result.previousVerdict,
          to: result.newVerdict,
        });

        // Prominent alert for confirmed→contradicted flips (data regression)
        if (result.previousVerdict === 'confirmed' && result.newVerdict === 'contradicted') {
          console.log(`    \x1b[41m\x1b[37m ⚠ DATA REGRESSION: was confirmed, now contradicted \x1b[0m`);
        }
      }

      const changeMarker = result.changed ? ' [CHANGED]' : '';
      const color = result.newVerdict === 'confirmed'
        ? '\x1b[32m'
        : result.newVerdict === 'contradicted'
          ? '\x1b[31m'
          : '\x1b[33m';
      console.log(`    ${color}${result.newVerdict}\x1b[0m (confidence: ${(result.confidence * 100).toFixed(0)}%)${changeMarker}`);

      // Issue #4017: storage failure must surface, not be silently swallowed.
      try {
        await storeRecheckResult(result);
      } catch (e: unknown) {
        summary.storageErrors++;
        console.warn(`    \x1b[33mStorage failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
      }
    }
  }

  // ── Build summary output ──
  // Storage errors mean primary-data writes were lost — non-zero exit even
  // if no verdict changes were detected. Issue #4017.
  const exitCode = summary.changed > 0 || summary.storageErrors > 0 ? 1 : 0;
  if (options.ci) {
    return {
      exitCode,
      output: JSON.stringify(summary),
    };
  }

  return { exitCode, output: formatSummaryOutput(summary) };
}

// ── Output formatting ────────────────────────────────────────────────

function formatDryRunOutput(
  items: DueItem[],
  totalDue: number,
  estimatedCost: number,
  options: RecheckOptions,
): CommandResult {
  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        totalDue,
        selected: items.length,
        estimatedCost,
        items: items.map((i) => ({
          recordType: i.recordType,
          recordId: i.recordId,
          verdict: i.verdict,
          priority: i.priority,
          needsRecheck: i.needsRecheck,
          nextCheckDue: i.nextCheckDue,
          lastComputedAt: i.lastComputedAt,
        })),
      }),
    };
  }

  const lines: string[] = [];
  lines.push(`\x1b[1mDry run: ${items.length} of ${totalDue} items would be rechecked\x1b[0m`);
  lines.push(`Estimated cost: \$${estimatedCost.toFixed(2)}`);
  lines.push('');

  // Verdict breakdown
  const byVerdict = new Map<string, number>();
  for (const item of items) {
    byVerdict.set(item.verdict, (byVerdict.get(item.verdict) ?? 0) + 1);
  }

  lines.push('\x1b[1mBy current verdict:\x1b[0m');
  for (const [verdict, cnt] of [...byVerdict.entries()].sort((a, b) => b[1] - a[1])) {
    const color = verdict === 'contradicted' ? '\x1b[31m' : verdict === 'confirmed' ? '\x1b[32m' : '\x1b[33m';
    lines.push(`  ${color}${verdict.padEnd(15)}\x1b[0m ${cnt}`);
  }
  lines.push('');

  // Record type breakdown
  const byType = new Map<string, number>();
  for (const item of items) {
    byType.set(item.recordType, (byType.get(item.recordType) ?? 0) + 1);
  }

  lines.push('\x1b[1mBy record type:\x1b[0m');
  for (const [type, cnt] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${type.padEnd(20)} ${cnt}`);
  }
  lines.push('');

  // Item list
  const header = `${'Priority'.padEnd(10)} ${'Verdict'.padEnd(15)} ${'Type'.padEnd(20)} ${'Record ID'.padEnd(30)} Last Checked`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(100));

  for (const item of items.slice(0, 30)) {
    const lastChecked = item.lastComputedAt
      ? new Date(item.lastComputedAt).toISOString().slice(0, 10)
      : 'never';
    const id = truncate(item.recordId, 30, { ellipsis: '...' });
    lines.push(
      `${String(item.priority).padEnd(10)} ${item.verdict.padEnd(15)} ${item.recordType.padEnd(20)} ${id.padEnd(30)} ${lastChecked}`,
    );
  }

  if (items.length > 30) {
    lines.push(`  ... and ${items.length - 30} more items`);
  }

  lines.push('');
  lines.push('Use without --dry-run to run rechecking with LLM.');

  return { exitCode: 0, output: lines.join('\n') };
}

function formatSummaryOutput(summary: RecheckSummary): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[1m=== Recheck Summary ===\x1b[0m');
  lines.push(`Total due:      ${summary.totalDue}`);
  lines.push(`Rechecked:      ${summary.rechecked}`);
  lines.push(`Errors:         ${summary.errors}`);
  if (summary.storageErrors > 0) {
    lines.push(
      `\x1b[31mStorage errors: ${summary.storageErrors} verdict(s) computed but NOT persisted to wiki-server. Re-run after the underlying issue is fixed (issue #4017).\x1b[0m`,
    );
  }
  lines.push(`Est. cost:      \$${summary.estimatedCost.toFixed(2)}`);
  lines.push('');

  lines.push(`\x1b[1mVerdict changes: ${summary.changed}\x1b[0m`);
  if (summary.verdictChanges.length > 0) {
    for (const change of summary.verdictChanges) {
      const fromColor = change.from === 'contradicted' ? '\x1b[31m' : '\x1b[33m';
      const toColor = change.to === 'confirmed' ? '\x1b[32m' : change.to === 'contradicted' ? '\x1b[31m' : '\x1b[33m';
      lines.push(`  ${change.recordType}/${change.recordId}: ${fromColor}${change.from}\x1b[0m -> ${toColor}${change.to}\x1b[0m`);
    }
  } else {
    lines.push('  No verdicts changed.');
  }
  lines.push('');

  lines.push('\x1b[1mNew verdict distribution:\x1b[0m');
  for (const [verdict, cnt] of Object.entries(summary.byVerdict).sort((a, b) => b[1] - a[1])) {
    const color = verdict === 'confirmed' ? '\x1b[32m' : verdict === 'contradicted' ? '\x1b[31m' : '\x1b[33m';
    lines.push(`  ${color}${verdict.padEnd(15)}\x1b[0m ${cnt}`);
  }

  if (summary.failures.length > 0) {
    lines.push('');
    lines.push(`\x1b[31mErrors (${summary.failures.length}):\x1b[0m`);
    for (const f of summary.failures.slice(0, 10)) {
      lines.push(`  ${f.recordType}/${f.recordId}: ${f.error}`);
    }
    if (summary.failures.length > 10) {
      lines.push(`  ... and ${summary.failures.length - 10} more errors`);
    }
  }

  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: recheckCommand,
};

export function getHelp(): string {
  return `
Source-Check Recheck — re-verify items that are due for rechecking

Usage:
  crux sourcing-recheck [options]           Re-verify items due for recheck
  crux tb sourcing-recheck [options]        Same, via tablebase group

Options:
  --budget=N             Max dollars to spend (default: 1.0, est. ~$0.01/item)
  --limit=N              Max number of items to recheck (default: 50)
  --type=X               Filter by record type (e.g., personnel, fact, grant)
  --verdict=X            Force-recheck all verdicts of this kind (confirmed |
                         contradicted | outdated | partial | unverifiable),
                         bypassing the next_check_due window. Used for
                         targeted prompt-improvement sweeps.
  --dry-run              Preview what would be rechecked without running LLM
  --ci                   JSON output for CI pipelines

Recheck intervals by verdict:
  confirmed:     90 days
  contradicted:   7 days
  outdated:      14 days
  partial:       30 days
  unverifiable:  60 days

Priority ordering (higher = rechecked first):
  contradicted:  100
  outdated:       80
  partial:        50
  unverifiable:   30
  confirmed:      10
`.trim();
}
