/**
 * Build the human-readable run summary and persist the per-record outcome
 * JSON file. The summary lines go to stdout via the command's CommandResult;
 * the JSON gets written to disk so a human can spot-check matched URLs and
 * triage no-match reasons after the fact.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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

export interface OutcomeFileInput {
  path: string;
  outcomes: RecordOutcome[];
  mode: 'apply' | 'dry-run';
  totalRecords: number;
  searched: number;
  matched: number;
}

/**
 * Write the run's per-record outcomes to a JSON file for post-hoc analysis.
 *
 * Matched items include the chosen URL + the verified quotes so a human can
 * spot-check for false positives without re-running the pipeline. Unmatched
 * + skipped items include the rejection reason for triage.
 *
 * Returns a status line for the summary block. The write is wrapped in a
 * try/catch so a write failure (read-only fs, missing dir perms) doesn't
 * derail the command — we surface the error in the summary instead.
 */
export function writeOutcomesJson(input: OutcomeFileInput): string {
  if (input.outcomes.length === 0) return '';

  const items = input.outcomes.map(serializeOutcome);
  const noMatchCount = items.filter(o => o.outcome === 'no-match').length;
  const skippedCount = items.filter(o => o.outcome === 'skipped').length;

  try {
    mkdirSync(dirname(input.path), { recursive: true });
    writeFileSync(
      input.path,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          mode: input.mode,
          totals: {
            records: input.totalRecords,
            searched: input.searched,
            matched: input.matched,
            unmatched: noMatchCount,
            skipped: skippedCount,
          },
          items,
        },
        null,
        2,
      ),
    );
    return `  Outcomes written: ${input.path} (${items.length} items: ${input.matched} matched, ${noMatchCount} no-match, ${skippedCount} skipped)`;
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
