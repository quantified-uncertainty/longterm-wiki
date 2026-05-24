/**
 * Backfill missing source URLs across all tables.
 *
 * For each record that has no source URL:
 *   1. Fetch the record from the wiki-server missing-sources endpoint
 *   2. Build a targeted web search query from the record's description
 *   3. Search using the research agent (Exa + Perplexity + SCRY)
 *   4. Verify any fetched page actually supports the record's claim
 *   5. Update the record's source field via the appropriate sync API
 *
 * Usage:
 *   pnpm crux tb backfill-sources --dry-run              # Preview only
 *   pnpm crux tb backfill-sources --limit=20 --apply     # Process 20 + update
 *   pnpm crux tb backfill-sources --table=facts --apply  # Only facts
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MAX_COST, PER_RECORD_BUDGET } from '../lib/backfill-sources/config.ts';
import { addCost, emptyCost, totalOf } from '../lib/backfill-sources/cost.ts';
import { fetchMissingSources, updateRecordSource } from '../lib/backfill-sources/fetch.ts';
import { extractMatchTerms } from '../lib/backfill-sources/match-terms.ts';
import { processRecord } from '../lib/backfill-sources/process-record.ts';
import { buildSummaryLines, writeOutcomesJson } from '../lib/backfill-sources/report.ts';
import type {
  CostBreakdown,
  MissingSourceRecord,
  RecordOutcome,
  YamlWriteRecordReport,
} from '../lib/backfill-sources/types.ts';
import { openYamlPr } from '../lib/backfill-sources/yaml-pr.ts';
import {
  buildFactbaseEntityIndex,
  buildPolicyEntityIndex,
} from '../lib/backfill-sources/yaml-target-resolvers.ts';
import { writeRecordToYaml, type YamlIndexes } from '../lib/backfill-sources/yaml-write.ts';

type CommandResult = { exitCode?: number; output?: string };
type CommandOptions = Record<string, unknown>;

interface ParsedOptions {
  dryRun: boolean;
  apply: boolean;
  limit: number;
  table?: string;
  recordIdFilter?: string;
  maxCost: number;
  verbose: boolean;
  debug: boolean;
  unmatchedOut: string;
  /** When true, skip the end-of-run YAML branch + commit + push + PR.
   *  Defaults to false; set via --no-yaml-pr for local dry-application
   *  testing where you want the YAML mutations on disk but no git activity. */
  skipYamlPr: boolean;
}

async function backfillSourcesCommand(args: string[], rawOptions: CommandOptions): Promise<CommandResult> {
  const parsed = parseOptions(rawOptions);
  if ('error' in parsed) return { exitCode: 1, output: parsed.error };

  console.log(`Fetching records without source URLs...`);
  const fetchResult = await fetchMissingSources(parsed);
  if ('error' in fetchResult) {
    return { exitCode: 1, output: `Failed to fetch missing sources: ${fetchResult.error}` };
  }

  const selection = selectRecords(fetchResult.records, parsed.recordIdFilter);
  if (selection.kind === 'filter-miss') {
    return {
      exitCode: 0,
      output: `No record found with record_id=${selection.recordId} in the first ${parsed.limit}/table fetched. Try raising --limit or removing the --record-id filter.`,
    };
  }
  if (selection.kind === 'empty') {
    return { exitCode: 0, output: 'No records without sources found.' };
  }
  const records = selection.records;

  console.log(`Found ${fetchResult.totalMissing} records without sources.`);
  console.log(`Budget cap: $${parsed.maxCost.toFixed(2)} (per-record cap $${PER_RECORD_BUDGET.toFixed(2)})\n`);

  const runStartedAt = new Date().toISOString();
  const run = await processAllRecords(records, parsed);

  const lines = buildSummaryLines({
    outcomes: run.outcomes,
    totalRecords: records.length,
    searched: run.searched,
    matched: run.matched,
    noTerms: run.noTerms,
    budgetSkipped: run.budgetSkipped,
    updatedCount: run.updatedCount,
    updateFailed: run.updateFailed,
    totalBreakdown: run.totalBreakdown,
    maxCost: parsed.maxCost,
    budgetStopped: run.budgetStopped,
    winningProviderCounts: run.winningProviderCounts,
    apply: parsed.apply,
    verbose: parsed.verbose,
  });

  const outcomeStatus = writeOutcomesJson({
    path: parsed.unmatchedOut,
    outcomes: run.outcomes,
    mode: parsed.apply ? 'apply' : 'dry-run',
    totalRecords: records.length,
    searched: run.searched,
    matched: run.matched,
  });
  if (outcomeStatus) lines.push(outcomeStatus);

  if (parsed.apply) {
    lines.push(
      `  YAML writes: ${run.factsYamlWritten} facts, ${run.stakeholdersYamlWritten} policy stakeholders` +
      ` (${run.touchedYamlPaths.size} files touched)`,
    );
  }

  if (parsed.apply && !parsed.skipYamlPr && run.touchedYamlPaths.size > 0) {
    const prResult = openYamlPr({
      touchedPaths: [...run.touchedYamlPaths].sort(),
      runStartedAt,
      summary: {
        matched: run.matched,
        factsWritten: run.factsYamlWritten,
        stakeholdersWritten: run.stakeholdersYamlWritten,
      },
    });
    if (prResult.kind === 'opened') {
      lines.push(`  YAML PR opened: ${prResult.prUrl} (branch: ${prResult.branch})`);
    } else if (prResult.kind === 'refused') {
      lines.push(`  YAML PR skipped: ${prResult.reason}`);
    } else {
      lines.push(`  YAML PR FAILED: ${prResult.error}`);
    }
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseOptions(o: CommandOptions): ParsedOptions | { error: string } {
  const dryRun = !!o.dryRun;
  const apply = !!o.apply;
  if (apply && dryRun) return { error: 'Cannot combine --dry-run and --apply. Pick one.' };
  if (!apply && !dryRun) return { error: 'Specify --dry-run (preview) or --apply (update records). Use --dry-run first.' };

  const maxCost = o.maxCost ? parseFloat(o.maxCost as string) : DEFAULT_MAX_COST;
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    return { error: `--max-cost must be a positive number (got ${o.maxCost})` };
  }

  const limit = o.limit ? parseInt(o.limit as string, 10) : 20;
  if (!Number.isFinite(limit) || limit <= 0) {
    return { error: `--limit must be a positive integer (got ${o.limit})` };
  }

  return {
    dryRun,
    apply,
    limit,
    table: o.table as string | undefined,
    recordIdFilter: o.recordId as string | undefined,
    maxCost,
    verbose: !!o.verbose,
    debug: !!o.debug,
    // Default into the OS temp dir, not dev/reports under the repo: the worker
    // container runs as a non-root user on a read-only repo and can't create
    // dev/reports. Pass --unmatched-out to write somewhere specific (e.g. a dev
    // checkout where you want the report committed/inspected).
    unmatchedOut: (o.unmatchedOut as string | undefined)
      ?? join(tmpdir(), `backfill-unmatched-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
    skipYamlPr: !!o.noYamlPr,
  };
}

// ---------------------------------------------------------------------------
// Record selection — applies the optional --record-id smoke-test filter
// ---------------------------------------------------------------------------

/**
 * The three possible outcomes of selecting which records to run on:
 *   - `ready`: we have records to process.
 *   - `empty`: the database had no records missing a source URL.
 *   - `filter-miss`: --record-id was set but the id wasn't in this batch.
 *     (The caller surfaces a "raise --limit" hint.)
 */
type RecordSelection =
  | { kind: 'ready'; records: MissingSourceRecord[] }
  | { kind: 'empty' }
  | { kind: 'filter-miss'; recordId: string };

/**
 * Apply the optional --record-id filter for single-record smoke-tests.
 * When no filter is set, returns all fetched records as-is.
 */
function selectRecords(
  fetched: MissingSourceRecord[],
  recordIdFilter: string | undefined,
): RecordSelection {
  if (!recordIdFilter) {
    return fetched.length === 0 ? { kind: 'empty' } : { kind: 'ready', records: fetched };
  }

  const matched = fetched.filter(r => r.record_id === recordIdFilter);
  console.log(`Single-record mode: ${matched.length} record(s) matched record_id=${recordIdFilter} (out of ${fetched.length})\n`);

  return matched.length === 0
    ? { kind: 'filter-miss', recordId: recordIdFilter }
    : { kind: 'ready', records: matched };
}

// ---------------------------------------------------------------------------
// Top-level loop — for each record: skip / budget-check / process / record outcome
// ---------------------------------------------------------------------------

interface RunTotals {
  outcomes: RecordOutcome[];
  matched: number;
  updatedCount: number;
  updateFailed: number;
  noTerms: number;
  searched: number;
  budgetSkipped: number;
  budgetStopped: boolean;
  totalBreakdown: CostBreakdown;
  winningProviderCounts: Record<string, number>;
  /** YAML files mutated during this run — staged explicitly at PR time. */
  touchedYamlPaths: Set<string>;
  factsYamlWritten: number;
  stakeholdersYamlWritten: number;
}

async function processAllRecords(
  records: MissingSourceRecord[],
  parsed: ParsedOptions,
): Promise<RunTotals> {
  const run: RunTotals = {
    outcomes: [],
    matched: 0,
    updatedCount: 0,
    updateFailed: 0,
    noTerms: 0,
    searched: 0,
    budgetSkipped: 0,
    budgetStopped: false,
    totalBreakdown: emptyCost(),
    winningProviderCounts: {},
    touchedYamlPaths: new Set<string>(),
    factsYamlWritten: 0,
    stakeholdersYamlWritten: 0,
  };

  // Build YAML target indexes once per apply-run. In dry-run we skip this
  // entirely — no writes happen so the index is unused.
  const indexes: YamlIndexes | null = parsed.apply
    ? {
        facts: buildFactbaseEntityIndex(),
        policies: buildPolicyEntityIndex(),
      }
    : null;
  if (indexes) {
    console.log(
      `YAML target index: ${indexes.facts.sidToFilepath.size} factbase entities` +
      ` (skipped ${indexes.facts.unindexedCount}), ${indexes.policies.sidToFilepath.size} policy entities` +
      ` (parse failures: ${indexes.policies.parseFailureCount}).\n`,
    );
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    if (extractMatchTerms(record).length === 0) {
      run.noTerms++;
      run.outcomes.push({ record, outcome: { kind: 'skipped', reason: 'no search terms' } });
      continue;
    }
    if (isTestRecord(record)) {
      run.outcomes.push({ record, outcome: { kind: 'skipped', reason: 'test record' } });
      continue;
    }
    if (totalOf(run.totalBreakdown) >= parsed.maxCost) {
      if (!run.budgetStopped) {
        run.budgetStopped = true;
        console.warn(`\n[budget] Reached $${totalOf(run.totalBreakdown).toFixed(4)} / $${parsed.maxCost.toFixed(2)} cap — stopping remaining records`);
      }
      run.budgetSkipped++;
      run.outcomes.push({ record, outcome: { kind: 'skipped', reason: 'budget cap' } });
      continue;
    }

    console.log(`[${i + 1}/${records.length}] ${record.record_table}/${record.record_id}: ${record.description.slice(0, 80)}`);
    run.searched++;

    const result = await processRecord(record, { dryRun: parsed.dryRun, apply: parsed.apply, debug: parsed.debug });
    addCost(run.totalBreakdown, result.cost);

    if (!result.matched) {
      run.outcomes.push({
        record,
        outcome: {
          kind: 'no-match',
          reason: result.reason,
          cost: result.cost,
          candidates: result.candidates,
        },
      });
      continue;
    }

    run.matched++;
    run.winningProviderCounts[result.provider ?? 'unknown'] =
      (run.winningProviderCounts[result.provider ?? 'unknown'] ?? 0) + 1;

    let updated: boolean | undefined;
    let yamlReport: YamlWriteRecordReport | undefined;
    if (parsed.apply) {
      updated = await updateRecordSource(record, result.url);
      if (updated) run.updatedCount++;
      else { run.updateFailed++; console.warn(`  ✗ Update failed — source not written`); }

      // Dual-write to YAML for facts + policy_stakeholders. The PG write
      // above is wiped by the YAML→PG sync workflow on the next push to
      // data/entities or packages/factbase/data/fb-entities, so we mirror
      // the write into YAML and let the sync re-populate PG durably.
      if (updated && indexes) {
        const yamlOutcome = writeRecordToYaml(record, result.url, indexes);
        yamlReport = {
          status: yamlOutcome.status,
          ...(yamlOutcome.filepath ? { filepath: yamlOutcome.filepath } : {}),
          ...(yamlOutcome.applicable && yamlOutcome.status === 'error' && yamlOutcome.error
            ? { error: yamlOutcome.error }
            : {}),
        };
        if (yamlOutcome.applicable && yamlOutcome.status === 'wrote' && yamlOutcome.filepath) {
          run.touchedYamlPaths.add(yamlOutcome.filepath);
          if (record.record_table === 'facts') run.factsYamlWritten++;
          if (record.record_table === 'policy_stakeholders') run.stakeholdersYamlWritten++;
          console.log(`    → YAML write: ${yamlOutcome.filepath}`);
        } else if (yamlOutcome.applicable) {
          console.warn(`    → YAML write ${yamlOutcome.status}` + (yamlReport.error ? `: ${yamlReport.error}` : ''));
        }
      }
    }

    run.outcomes.push({
      record,
      outcome: {
        kind: 'matched',
        url: result.url,
        provider: result.provider,
        quotes: result.quotes,
        updated,
        yaml_write: yamlReport,
        cost: result.cost,
        candidates: result.candidates,
      },
    });
  }

  return run;
}

/** Drop seed/test records that pollute the dataset. */
function isTestRecord(record: MissingSourceRecord): boolean {
  const entityName = (record.entity_name ?? '').trim();
  return entityName === 'Test' || record.record_id === 'test123456';
}

export const commands = {
  default: backfillSourcesCommand,
};
