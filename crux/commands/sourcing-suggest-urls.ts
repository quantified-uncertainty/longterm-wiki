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
  type UrlSuggestionInput,
} from '../lib/wiki-server/sourcing-client.ts';
import {
  suggestUrls,
  type UrlSuggestion,
} from '../lib/sourcing/suggest-urls.ts';

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const DEFAULT_BUDGET_USD = 1.0;
const DEFAULT_MAX_CANDIDATES = 3;
const MAX_CANDIDATES_PER_RECORD = 10;
const GENERATOR_MODEL = 'qua-64/suggest-urls-v1';

// ── Option helpers ───────────────────────────────────────────────────

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

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function parsePositiveFloat(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// ── Core run ─────────────────────────────────────────────────────────

interface RunSummary {
  scanned: number;
  skippedHadSuggestion: number;
  skippedNoClaim: number;
  generatedForRecords: number;
  suggestionsWritten: number;
  providerErrors: number;
  costUsd: number;
  budgetExhausted: boolean;
  providers: { used: Set<string>; skipped: Set<string> };
}

async function suggestCommand(
  _args: string[],
  options: SuggestOptions,
): Promise<CommandResult> {
  const limit = parsePositiveInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const budgetCap = parsePositiveFloat(options.budget, DEFAULT_BUDGET_USD);
  const maxCandidates = parsePositiveInt(
    options['max-candidates'] ?? options.maxCandidates,
    DEFAULT_MAX_CANDIDATES,
    MAX_CANDIDATES_PER_RECORD,
  );
  const recordTypeFilter = options.type?.trim() || undefined;
  const entityFilter = options.entity?.trim() || undefined;
  const dryRun = Boolean(options['dry-run'] ?? options.dryRun);
  const skipExisting = options['skip-existing'] ?? options.skipExisting ?? true;
  const isJson = Boolean(options.json || options.ci);

  const log = (msg: string) => {
    if (!isJson) console.log(msg);
  };

  log(`Sourcing Suggest URLs (QUA-64)`);
  log(`  limit:          ${limit}`);
  log(`  budget:         $${budgetCap.toFixed(2)}`);
  log(`  max-candidates: ${maxCandidates}`);
  if (recordTypeFilter) log(`  record type:    ${recordTypeFilter}`);
  if (entityFilter) log(`  entity:         ${entityFilter}`);
  if (dryRun) log(`  dry-run:        yes`);
  log('');

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

  let verdictRows = verdictsResult.data.verdicts;
  if (entityFilter) {
    verdictRows = verdictRows.filter(
      (v) =>
        v.entityId === entityFilter ||
        (v.entityDisplayName ?? '').toLowerCase() === entityFilter.toLowerCase(),
    );
  }

  log(`Fetched ${verdictRows.length} unverifiable verdict(s).`);

  if (verdictRows.length === 0) {
    return {
      exitCode: 0,
      output: isJson
        ? JSON.stringify({ summary: emptySummary() })
        : 'No unverifiable verdicts matched.',
    };
  }

  // ── Step 2: per-record processing ──
  const summary: RunSummary = {
    scanned: 0,
    skippedHadSuggestion: 0,
    skippedNoClaim: 0,
    generatedForRecords: 0,
    suggestionsWritten: 0,
    providerErrors: 0,
    costUsd: 0,
    budgetExhausted: false,
    providers: { used: new Set<string>(), skipped: new Set<string>() },
  };

  const allSuggestions: UrlSuggestionInput[] = [];

  // Batch pre-fetch: build a set of (recordType, recordId) pairs that already
  // have a pending suggestion, so we don't make one HTTP call per record.
  const existingPendingSet = skipExisting
    ? await buildExistingPendingSet(recordTypeFilter, verdictRows.length, log)
    : new Set<string>();

  for (const v of verdictRows) {
    summary.scanned++;

    if (summary.costUsd >= budgetCap) {
      summary.budgetExhausted = true;
      log(`Budget reached ($${summary.costUsd.toFixed(4)} >= $${budgetCap.toFixed(2)}); stopping.`);
      break;
    }

    // Claim text = verdict.reasoning (set by the sourcing LLM). If missing
    // fall back to displayName. If both missing, skip — we have nothing to search.
    const claimText = v.reasoning?.trim() || v.displayName?.trim() || '';
    const entityName =
      v.entityDisplayName?.trim() || v.entityId?.trim() || v.displayName?.trim() || '';
    if (!claimText || !entityName) {
      summary.skippedNoClaim++;
      continue;
    }

    if (skipExisting && existingPendingSet.has(`${v.recordType}|${v.recordId}`)) {
      summary.skippedHadSuggestion++;
      continue;
    }

    // Look up an existing evidence URL so we don't re-suggest the same thing.
    let existingUrl: string | null = null;
    const evidence = await getEvidenceByRecord(v.recordType, v.recordId, { limit: 5 });
    if (evidence.ok) {
      const withUrl = evidence.data.evidence.find((e) => e.sourceUrl);
      existingUrl = withUrl?.sourceUrl ?? null;
    }

    if (dryRun) {
      log(`  [dry-run] ${v.recordType}/${v.recordId} field=${v.fieldName ?? '(row)'} entity="${entityName.slice(0, 40)}"`);
      summary.generatedForRecords++;
      continue;
    }

    // Generate candidates.
    const result = await suggestUrls({
      entityName,
      claimText,
      fieldName: v.fieldName ?? undefined,
      existingUrl,
      maxCandidates,
    });

    summary.costUsd += result.costUsd;
    for (const p of result.providersUsed) summary.providers.used.add(p);
    for (const p of result.providersSkipped) {
      summary.providers.skipped.add(p);
      if (!p.endsWith(':no-key')) summary.providerErrors++;
    }

    if (result.candidates.length === 0) continue;

    summary.generatedForRecords++;

    for (const cand of result.candidates) {
      allSuggestions.push(
        toSuggestionInput(v, cand),
      );
    }
  }

  // ── Step 3: batch-upsert ──
  if (!dryRun && allSuggestions.length > 0) {
    // Chunk by 100 to stay well under the route's 200-item limit.
    const CHUNK = 100;
    for (let i = 0; i < allSuggestions.length; i += CHUNK) {
      const chunk = allSuggestions.slice(i, i + CHUNK);
      const upsert = await upsertUrlSuggestions(chunk);
      if (!upsert.ok) {
        return {
          exitCode: 1,
          output: `upsert failed at chunk ${i / CHUNK + 1}: ${upsert.message ?? 'unknown error'}`,
        };
      }
      summary.suggestionsWritten += upsert.data.upserted;
    }
  }

  // ── Step 4: output ──
  const summaryPayload = {
    scanned: summary.scanned,
    skipped_had_suggestion: summary.skippedHadSuggestion,
    skipped_no_claim: summary.skippedNoClaim,
    generated_for_records: summary.generatedForRecords,
    suggestions_written: summary.suggestionsWritten,
    provider_errors: summary.providerErrors,
    cost_usd: Number(summary.costUsd.toFixed(4)),
    budget_exhausted: summary.budgetExhausted,
    providers_used: [...summary.providers.used].sort(),
    providers_skipped: [...summary.providers.skipped].sort(),
    dry_run: dryRun,
  };

  if (isJson) {
    return { exitCode: 0, output: JSON.stringify({ summary: summaryPayload }) };
  }

  const lines = [
    '',
    '=== Summary ===',
    `Scanned:                ${summary.scanned}`,
    `Skipped (had pending):  ${summary.skippedHadSuggestion}`,
    `Skipped (no claim):     ${summary.skippedNoClaim}`,
    `Generated for records:  ${summary.generatedForRecords}`,
    `Suggestions written:    ${summary.suggestionsWritten}${dryRun ? ' (dry-run)' : ''}`,
    `Provider errors:        ${summary.providerErrors}`,
    `Cost:                   $${summary.costUsd.toFixed(4)}`,
    `Budget exhausted:       ${summary.budgetExhausted ? 'yes' : 'no'}`,
    `Providers used:         ${[...summary.providers.used].sort().join(', ') || '(none)'}`,
    summary.providers.skipped.size > 0
      ? `Providers skipped:      ${[...summary.providers.skipped].sort().join(', ')}`
      : '',
  ].filter(Boolean);

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Pre-fetch all pending suggestions in one or two paginated calls rather than
 * N per-record lookups. Returns a set of `${recordType}|${recordId}` keys.
 * Failures are swallowed (set stays empty) — the caller will still process
 * records, just without deduping.
 */
async function buildExistingPendingSet(
  recordTypeFilter: string | undefined,
  expectedVerdictCount: number,
  log: (msg: string) => void,
): Promise<Set<string>> {
  const set = new Set<string>();
  // Over-fetch a bit to cover any stale pending rows beyond the current scan size.
  // Cap at 2000 to avoid unbounded paging — the route clamps to 200 per page.
  const MAX_PREFETCH = 2000;
  const PAGE_SIZE = 200;
  const target = Math.min(MAX_PREFETCH, Math.max(expectedVerdictCount * 2, PAGE_SIZE));

  let offset = 0;
  while (offset < target) {
    const res = await listUrlSuggestions({
      recordType: recordTypeFilter,
      status: 'pending',
      limit: PAGE_SIZE,
      offset,
    });
    if (!res.ok) {
      log(`  [warn] pre-fetch pending suggestions failed: ${res.message ?? 'unknown'}`);
      return set;
    }
    for (const s of res.data.suggestions) {
      set.add(`${s.recordType}|${s.recordId}`);
    }
    if (res.data.suggestions.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return set;
}

function emptySummary() {
  return {
    scanned: 0,
    skipped_had_suggestion: 0,
    skipped_no_claim: 0,
    generated_for_records: 0,
    suggestions_written: 0,
    provider_errors: 0,
    cost_usd: 0,
    budget_exhausted: false,
    providers_used: [] as string[],
    providers_skipped: [] as string[],
    dry_run: false,
  };
}

function toSuggestionInput(
  v: {
    recordType: string;
    recordId: string;
    fieldName: string | null;
    entityId: string | null;
  },
  cand: UrlSuggestion,
): UrlSuggestionInput {
  return {
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
  };
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

