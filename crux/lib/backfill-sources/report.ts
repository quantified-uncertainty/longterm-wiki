/**
 * Build the human-readable run summary and persist the per-record outcome
 * file. The summary lines go to stdout via the command's CommandResult; the
 * outcomes get written to disk so a human can spot-check matched URLs and
 * triage no-match reasons after the fact.
 *
 * The outcome file is JSONL (one record per line), written incrementally as
 * each record finishes — see openOutcomeJsonl/appendOutcomeJsonl. This keeps
 * memory flat regardless of batch size: we never hold every record's results
 * (let alone a single giant pretty-printed JSON string of all of them) in
 * memory at once, which previously OOM'd large backfill runs.
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { humanizeClaim } from './humanize-claim.ts';
import { totalOf } from './cost.ts';
import type { CostBreakdown, RecordOutcome } from './types.ts';

export interface SummaryInput {
  outcomes: RecordOutcome[];
  totalRecords: number;
  searched: number;
  matched: number;
  noTerms: number;
  budgetSkipped: number;
  updatedCount: number;
  updateFailed: number;
  totalBreakdown: CostBreakdown;
  maxCost: number;
  budgetStopped: boolean;
  winningProviderCounts: Record<string, number>;
  apply: boolean;
  verbose: boolean;
}

/** Top-level, human-readable summary with optional per-record list when --verbose. */
export function buildSummaryLines(input: SummaryInput): string[] {
  const totalCost = totalOf(input.totalBreakdown);
  const mode = input.apply ? 'apply' : 'dry-run';
  const lines = [
    `[backfill-sources] ${mode}${input.budgetStopped ? ' (stopped at budget cap)' : ''}`,
    `  Records: ${input.totalRecords} total`,
    `    Skipped (no search terms): ${input.noTerms}`,
    `    Skipped (budget cap): ${input.budgetSkipped}`,
    `    Searched: ${input.searched}`,
    `      Sources found: ${input.matched}`,
    `      No match: ${input.searched - input.matched}`,
  ];
  if (input.apply) {
    lines.push(`    DB updates: ${input.updatedCount} written, ${input.updateFailed} failed`);
  }
  lines.push(`  Cost: $${totalCost.toFixed(4)} / $${input.maxCost.toFixed(2)} cap`);
  lines.push(`    Perplexity search:        $${input.totalBreakdown.searchCost.toFixed(4)}`);
  lines.push(`    Haiku fact-extract:       $${input.totalBreakdown.factExtractionCost.toFixed(4)}`);
  lines.push(`    Haiku quote-extract:      $${input.totalBreakdown.quoteExtractCost.toFixed(4)}`);
  lines.push(`    Sonnet entailment check:  $${input.totalBreakdown.entailmentCost.toFixed(4)}`);
  lines.push(`    Haiku ranking:            $${input.totalBreakdown.rankCost.toFixed(4)}`);

  if (input.matched > 0) {
    lines.push(`  Winning source by provider (${input.matched} total):`);
    const sorted = Object.entries(input.winningProviderCounts).sort(([, a], [, b]) => b - a);
    for (const [key, count] of sorted) {
      lines.push(`    ${key.padEnd(24)} ${count}`);
    }
  }

  if (input.verbose) {
    lines.push('', '=== Per-record outcomes ===');
    for (const item of input.outcomes) {
      lines.push(formatOutcomeLine(item));
      if (item.outcome.kind === 'matched') {
        lines.push(`        → ${item.outcome.url}`);
      }
    }
  }

  return lines;
}

function formatOutcomeLine({ record, outcome }: RecordOutcome): string {
  const id = `${record.record_table}/${record.record_id}`;
  const desc = record.description.slice(0, 80);

  if (outcome.kind === 'matched') {
    const tag = outcome.updated === undefined
      ? '✓'
      : outcome.updated ? '✓ (written)' : '✓ (write failed)';
    const cost = totalOf(outcome.cost);
    const provider = outcome.provider ? ` from ${outcome.provider}` : '';
    return `  ${tag} ${id} — ${desc}  [$${cost.toFixed(4)}${provider}]`;
  }
  if (outcome.kind === 'no-match') {
    const cost = totalOf(outcome.cost);
    return `  ✗ ${id} — ${desc}  [${outcome.reason}; $${cost.toFixed(4)}]`;
  }
  return `  · ${id} — ${desc}  [skipped: ${outcome.reason}]`;
}

// ---------------------------------------------------------------------------
// Per-record JSON outcome file
// ---------------------------------------------------------------------------

export interface OutcomeJsonlTotals {
  records: number;
  searched: number;
  matched: number;
  unmatched: number;
  skipped: number;
}

/**
 * Open (truncate) the JSONL outcome file and write a `meta` header line.
 *
 * Returns true if the file is writable. If it isn't (read-only fs, missing
 * perms) the caller simply skips the per-record writes — the run still
 * completes; the file is for post-hoc triage only, never load-bearing.
 */
export function openOutcomeJsonl(path: string, mode: 'apply' | 'dry-run'): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ type: 'meta', generated_at: new Date().toISOString(), mode }) + '\n',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Append one record's outcome as a single JSONL line.
 *
 * Matched items include the chosen URL + verified quotes so a human can
 * spot-check for false positives; unmatched/skipped items carry the reason.
 * Best-effort: a mid-run write failure is swallowed so it can't abort the run.
 */
export function appendOutcomeJsonl(path: string, outcome: RecordOutcome): void {
  try {
    appendFileSync(path, JSON.stringify(serializeOutcome(outcome)) + '\n');
  } catch {
    // Triage-only file — never derail the run on a write failure.
  }
}

/**
 * Append the trailing `summary` line with the run totals, and return a status
 * line for the human-readable summary block.
 */
export function closeOutcomeJsonl(path: string, totals: OutcomeJsonlTotals): string {
  try {
    appendFileSync(path, JSON.stringify({ type: 'summary', totals }) + '\n');
    return `  Outcomes written: ${path} (${totals.searched + totals.skipped} items: ${totals.matched} matched, ${totals.unmatched} no-match, ${totals.skipped} skipped)`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `  Outcomes write FAILED: ${msg}`;
  }
}

/**
 * Split research-agent's `'exa+perplexity'` provider string back into an
 * array. Empty/null input → `[]`. Trims and dedupes for safety.
 */
export function splitProviders(provider: string | null | undefined): string[] {
  if (!provider) return [];
  const seen = new Set<string>();
  for (const p of provider.split('+')) {
    const trimmed = p.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort();
}

function serializeOutcome({ record, outcome }: RecordOutcome) {
  const base = {
    record_table: record.record_table,
    record_id: record.record_id,
    entity_name: record.entity_name ?? null,
    description: record.description,
    claim: humanizeClaim(record),
  };
  if (outcome.kind === 'matched') {
    return {
      ...base,
      outcome: 'matched' as const,
      url: outcome.url,
      provider: outcome.provider ?? null,
      // Full provider list (one entry per source that returned this URL).
      // research-agent encodes multi-provider hits as `'exa+perplexity'`;
      // splitting back to an array makes the field easy to aggregate when
      // tuning provider weights from past runs.
      providers: splitProviders(outcome.provider),
      // Verbatim quotes Sonnet judged as supporting the claim — included so a
      // human can spot-check for false positives without re-running.
      quotes: outcome.quotes ?? [],
      yaml_write: outcome.yaml_write ?? null,
      cost_usd: totalOf(outcome.cost),
      candidates: outcome.candidates,
    };
  }
  if (outcome.kind === 'no-match') {
    return {
      ...base,
      outcome: 'no-match' as const,
      reason: outcome.reason,
      cost_usd: totalOf(outcome.cost),
      candidates: outcome.candidates,
    };
  }
  return { ...base, outcome: 'skipped' as const, reason: outcome.reason, cost_usd: 0 };
}
