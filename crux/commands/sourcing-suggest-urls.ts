/**
 * Sourcing Suggest URLs — QUA-64
 *
 * For records whose sourcing verdict is `unverifiable`, run web search for
 * the claim + entity name and store 1-3 candidate URLs for human review or
 * auto-recheck.
 *
 * Workflow:
 *   1. List verdicts with verdict='unverifiable' (optional --type/--entity filter).
 *   2. For each, pull one evidence row to learn the existing URL (so we skip it).
 *   3. Generate candidates via crux/lib/sourcing/suggest-urls.ts
 *   4. Batch-upsert to /api/sourcing/url-suggestions.
 *
 * Safeguards:
 *   - --budget caps total Perplexity cost (default $1 — Exa is free-at-this-scale).
 *   - --limit caps records processed.
 *   - --dry-run prints what it would do without calling providers or writing.
 *   - Per-record timeout inherited from research-agent (30s).
 */

import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from '../lib/command-types.ts';
import {
  listVerdicts,
  getEvidenceByRecord,
  listUrlSuggestions,
  upsertUrlSuggestions,
} from '../lib/wiki-server/sourcing-client.ts';
import { suggestUrls } from '../lib/sourcing/suggest-urls.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const DEFAULT_BUDGET_USD = 1.0;
const DEFAULT_MAX_CANDIDATES = 3;
const MAX_CANDIDATES_PER_RECORD = 10;
const GENERATOR_MODEL = 'qua-64/suggest-urls-v1';
const PREFETCH_PAGE_SIZE = 200;
const PREFETCH_MAX = 2000;
const UPSERT_CHUNK = 100;

interface SuggestOptions extends BaseOptions {
  limit?: string;
  budget?: string;
  type?: string;
  entity?: string;
  'max-candidates'?: string;
  maxCandidates?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  json?: boolean;
  ci?: boolean;
  'skip-existing'?: boolean;
  skipExisting?: boolean;
}

function parseBoundedInt(raw: unknown, fallback: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

function parsePositiveFloat(raw: unknown, fallback: number): number {
  const n = parseFloat(String(raw ?? ''));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface RunSummary {
  scanned: number;
  skippedHadSuggestion: number;
  skippedNoClaim: number;
  generatedForRecords: number;
  suggestionsWritten: number;
  providerErrors: number;
  costUsd: number;
  budgetExhausted: boolean;
  providersUsed: Set<string>;
  providersSkipped: Set<string>;
}

function makeSummary(): RunSummary {
  return {
    scanned: 0,
    skippedHadSuggestion: 0,
    skippedNoClaim: 0,
    generatedForRecords: 0,
    suggestionsWritten: 0,
    providerErrors: 0,
    costUsd: 0,
    budgetExhausted: false,
    providersUsed: new Set(),
    providersSkipped: new Set(),
  };
}

function summaryToJson(s: RunSummary, dryRun: boolean) {
  return {
    scanned: s.scanned,
    skipped_had_suggestion: s.skippedHadSuggestion,
    skipped_no_claim: s.skippedNoClaim,
    generated_for_records: s.generatedForRecords,
    suggestions_written: s.suggestionsWritten,
    provider_errors: s.providerErrors,
    cost_usd: Number(s.costUsd.toFixed(4)),
    budget_exhausted: s.budgetExhausted,
    providers_used: [...s.providersUsed].sort(),
    providers_skipped: [...s.providersSkipped].sort(),
    dry_run: dryRun,
  };
}

function formatSummary(s: RunSummary, dryRun: boolean): string {
  const usedList = [...s.providersUsed].sort().join(', ') || '(none)';
  const skippedLine = s.providersSkipped.size > 0
    ? `\nProviders skipped:      ${[...s.providersSkipped].sort().join(', ')}`
    : '';
  return (
`
=== Summary ===
Scanned:                ${s.scanned}
Skipped (had pending):  ${s.skippedHadSuggestion}
Skipped (no claim):     ${s.skippedNoClaim}
Generated for records:  ${s.generatedForRecords}
Suggestions written:    ${s.suggestionsWritten}${dryRun ? ' (dry-run)' : ''}
Provider errors:        ${s.providerErrors}
Cost:                   $${s.costUsd.toFixed(4)}
Budget exhausted:       ${s.budgetExhausted ? 'yes' : 'no'}
Providers used:         ${usedList}${skippedLine}`
  );
}

/**
 * Batch pre-fetch pending suggestions up to PREFETCH_MAX so we can dedup the
 * per-record skip check in O(1) per row instead of one HTTP call per verdict.
 * Failures return an empty set — the caller processes records without deduping.
 */
async function fetchPendingRecordKeys(
  recordTypeFilter: string | undefined,
  log: (msg: string) => void,
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (let offset = 0; offset < PREFETCH_MAX; offset += PREFETCH_PAGE_SIZE) {
    const res = await listUrlSuggestions({
      recordType: recordTypeFilter,
      status: 'pending',
      limit: PREFETCH_PAGE_SIZE,
      offset,
    });
    if (!res.ok) {
      log(`  [warn] pre-fetch pending suggestions failed: ${res.message ?? 'unknown'}`);
      return keys;
    }
    for (const s of res.data.suggestions) keys.add(`${s.recordType}|${s.recordId}`);
    if (res.data.suggestions.length < PREFETCH_PAGE_SIZE) break;
  }
  return keys;
}

async function suggestCommand(
  _args: string[],
  options: SuggestOptions,
): Promise<CommandResult> {
  const limit = parseBoundedInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const budgetCap = parsePositiveFloat(options.budget, DEFAULT_BUDGET_USD);
  const maxCandidates = parseBoundedInt(
    options['max-candidates'] ?? options.maxCandidates,
    DEFAULT_MAX_CANDIDATES,
    MAX_CANDIDATES_PER_RECORD,
  );
  const recordTypeFilter = options.type?.trim() || undefined;
  const entityFilter = options.entity?.trim() || undefined;
  const dryRun = Boolean(options['dry-run'] ?? options.dryRun);
  const skipExisting = options['skip-existing'] ?? options.skipExisting ?? true;
  const isJson = Boolean(options.json || options.ci);

  const log = (msg: string) => { if (!isJson) console.log(msg); };

  log(`Sourcing Suggest URLs (QUA-64)`);
  log(`  limit:          ${limit}`);
  log(`  budget:         $${budgetCap.toFixed(2)}`);
  log(`  max-candidates: ${maxCandidates}`);
  if (recordTypeFilter) log(`  record type:    ${recordTypeFilter}`);
  if (entityFilter) log(`  entity:         ${entityFilter}`);
  if (dryRun) log(`  dry-run:        yes`);
  log('');

  const summary = makeSummary();

  // ── Step 1: list unverifiable verdicts ──
  const verdictsResult = await listVerdicts({
    verdict: 'unverifiable',
    recordType: recordTypeFilter,
    limit,
  });
  if (!verdictsResult.ok) {
    return {
      exitCode: 1,
      output: `Failed to list unverifiable verdicts: ${verdictsResult.message ?? 'unknown error'}`,
    };
  }

  const verdictRows = entityFilter
    ? verdictsResult.data.verdicts.filter(
        (v) =>
          v.entityId === entityFilter ||
          (v.entityDisplayName ?? '').toLowerCase() === entityFilter.toLowerCase(),
      )
    : verdictsResult.data.verdicts;

  log(`Fetched ${verdictRows.length} unverifiable verdict(s).`);

  if (verdictRows.length === 0) {
    const output = isJson
      ? JSON.stringify({ summary: summaryToJson(summary, dryRun) })
      : 'No unverifiable verdicts matched.';
    return { exitCode: 0, output };
  }

  // ── Step 2: per-record processing ──
  const pendingKeys = skipExisting
    ? await fetchPendingRecordKeys(recordTypeFilter, log)
    : new Set<string>();

  const toUpsert: Parameters<typeof upsertUrlSuggestions>[0] = [];

  for (const v of verdictRows) {
    summary.scanned++;

    if (summary.costUsd >= budgetCap) {
      summary.budgetExhausted = true;
      log(`Budget reached ($${summary.costUsd.toFixed(4)} >= $${budgetCap.toFixed(2)}); stopping.`);
      break;
    }

    // Claim text = verdict.reasoning (set by the sourcing LLM). Fall back to
    // displayName. If both missing, skip — we have nothing to search.
    const claimText = v.reasoning?.trim() || v.displayName?.trim() || '';
    const entityName =
      v.entityDisplayName?.trim() || v.entityId?.trim() || v.displayName?.trim() || '';
    if (!claimText || !entityName) {
      summary.skippedNoClaim++;
      continue;
    }

    if (skipExisting && pendingKeys.has(`${v.recordType}|${v.recordId}`)) {
      summary.skippedHadSuggestion++;
      continue;
    }

    // Look up the existing evidence URL so we don't re-suggest it.
    const evidence = await getEvidenceByRecord(v.recordType, v.recordId, { limit: 5 });
    const existingUrl =
      (evidence.ok && evidence.data.evidence.find((e) => e.sourceUrl)?.sourceUrl) || null;

    if (dryRun) {
      log(`  [dry-run] ${v.recordType}/${v.recordId} field=${v.fieldName ?? '(row)'} entity="${entityName.slice(0, 40)}"`);
      summary.generatedForRecords++;
      continue;
    }

    const result = await suggestUrls({
      entityName,
      claimText,
      fieldName: v.fieldName ?? undefined,
      existingUrl,
      maxCandidates,
    });

    summary.costUsd += result.costUsd;
    for (const p of result.providersUsed) summary.providersUsed.add(p);
    for (const p of result.providersSkipped) {
      summary.providersSkipped.add(p);
      if (!p.endsWith(':no-key')) summary.providerErrors++;
    }

    if (result.candidates.length === 0) continue;
    summary.generatedForRecords++;

    for (const cand of result.candidates) {
      toUpsert.push({
        recordType: v.recordType,
        recordId: v.recordId,
        fieldName: v.fieldName,
        entityId: v.entityId,
        suggestedUrl: cand.url,
        title: cand.title,
        snippet: cand.snippet,
        relevanceScore: cand.relevanceScore,
        sourceProvider: cand.sourceProvider,
        generatorModel: GENERATOR_MODEL,
        status: 'pending',
      });
    }
  }

  // ── Step 3: batch-upsert in chunks under the route's MAX_BATCH=200 ──
  if (!dryRun && toUpsert.length > 0) {
    for (let i = 0; i < toUpsert.length; i += UPSERT_CHUNK) {
      const chunk = toUpsert.slice(i, i + UPSERT_CHUNK);
      const upsert = await upsertUrlSuggestions(chunk);
      if (!upsert.ok) {
        return {
          exitCode: 1,
          output: `upsert failed at chunk ${i / UPSERT_CHUNK + 1}: ${upsert.message ?? 'unknown error'}`,
        };
      }
      summary.suggestionsWritten += upsert.data.upserted;
    }
  }

  const output = isJson
    ? JSON.stringify({ summary: summaryToJson(summary, dryRun) })
    : formatSummary(summary, dryRun);
  return { exitCode: 0, output };
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: suggestCommand,
};

export function getHelp(): string {
  return `
Sourcing Suggest URLs — auto-suggest better source URLs for unverifiable verdicts

Usage:
  crux sourcing-suggest-urls [options]

Options:
  --limit=N              Max unverifiable verdicts to scan (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})
  --budget=N             Soft cap in USD on search-provider spend (default: $${DEFAULT_BUDGET_USD.toFixed(2)}).
                         Checked before each record — a single in-flight call can overshoot.
  --type=X               Filter by record type (e.g., fact, grant, personnel)
  --entity=X             Filter by entityId or entityDisplayName
  --max-candidates=N     Candidates per record (default: ${DEFAULT_MAX_CANDIDATES}, max: ${MAX_CANDIDATES_PER_RECORD})
  --skip-existing        Skip records with existing pending suggestions (default: on)
  --dry-run              Enumerate records without calling providers or writing
  --json / --ci          Machine-readable JSON output

Workflow:
  1. Lists verdicts with verdict='unverifiable' from /api/sourcing/verdicts.
  2. Runs web search (Exa + Perplexity) for the claim + entity name.
  3. Batch-upserts candidates to /api/sourcing/url-suggestions for human review
     or auto-recheck. Human decisions (approved/rejected) are preserved on re-runs.

Requires EXA_API_KEY and/or OPENROUTER_API_KEY. Missing keys degrade gracefully.
Requires WIKI_SERVER_ENV=prod in agent slots.
`.trim();
}

