/**
 * Sourcing Suggest URLs — QUA-64 (QUA-587: extended to partial verdicts)
 *
 * For records whose sourcing verdict is `unverifiable` (default) or `partial`,
 * run web search for the claim + entity name and store 1-3 candidate URLs for
 * human review or auto-recheck.
 *
 * Workflow:
 *   1. List verdicts with verdict=<flag> (optional --type/--entity filter).
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
  getEvidenceByRecords,
  evidenceRecordKey,
  MAX_EVIDENCE_BY_RECORDS,
  listUrlSuggestions,
  upsertUrlSuggestions,
} from '../lib/wiki-server/sourcing-client.ts';
import { suggestUrls, GENERATOR_MODEL } from '../lib/sourcing/suggest-urls.ts';
import {
  gradeSuggestion,
  DEFAULT_GRADER_MODEL,
  MAX_REASONING_CHARS,
  type GraderOutcome,
} from '../lib/sourcing/grade-suggestion.ts';
import { createClient as createAnthropicClient } from '../lib/anthropic.ts';
import type { SourcingVerdict } from '../../apps/wiki-server/src/api-types.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const DEFAULT_BUDGET_USD = 1.0;
const DEFAULT_MAX_CANDIDATES = 3;
const MAX_CANDIDATES_PER_RECORD = 10;
const PREFETCH_PAGE_SIZE = 200;
const PREFETCH_MAX = 2000;
const UPSERT_CHUNK = 100;
const DEFAULT_CONCURRENCY = 5;

const DEFAULT_VERDICT: SourcingVerdict = 'unverifiable';
// Only verdicts where weak source URLs are the suspected root cause.
// `partial` added per QUA-587 — QUA-546 found re-verification was
// ineffective for partials because the source URLs themselves are weak.
// Deliberately excluded:
//   - `confirmed`: the source works; no reason to replace it.
//   - `contradicted`: the source disagrees substantively; replacing the
//     URL would mask the disagreement. Route through crux sourcing-recheck
//     instead.
//   - `outdated`: handled via the recheck path (crux sourcing-recheck
//     --verdict=outdated re-fetches the same URL looking for updates),
//     not URL replacement. Staleness is a value-refresh problem, not a
//     URL-quality problem. If this turns out to be wrong in practice we
//     can widen the allowlist — the ticket (QUA-587) explicitly scopes
//     this change to unverifiable + partial.
//   - `unchecked`: no verdict yet to remediate.
// NOTE: sourcing-recheck.ts uses a broader allowlist (all 5 real verdicts)
// because its semantics differ — it reruns the LLM against current
// evidence, which is valid for any verdict type.
// Outer type is Set<string> so .has() accepts raw user input; members are
// typed SourcingVerdict so TS catches a typo or invalid verdict here.
const ALLOWED_SUGGEST_VERDICTS: ReadonlySet<string> = new Set<SourcingVerdict>([
  'unverifiable',
  'partial',
]);
// Guard drift between DEFAULT_VERDICT and the allowlist.
if (!ALLOWED_SUGGEST_VERDICTS.has(DEFAULT_VERDICT)) {
  throw new Error(`DEFAULT_VERDICT "${DEFAULT_VERDICT}" is not in ALLOWED_SUGGEST_VERDICTS`);
}

interface SuggestOptions extends BaseOptions {
  limit?: string;
  budget?: string;
  type?: string;
  entity?: string;
  verdict?: string;
  'max-candidates'?: string;
  maxCandidates?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  json?: boolean;
  ci?: boolean;
  'skip-existing'?: boolean;
  skipExisting?: boolean;
  'auto-approve-threshold'?: string;
  autoApproveThreshold?: string;
  'auto-approve-model'?: string;
  autoApproveModel?: string;
}

/**
 * Parse a numeric flag; return `fallback` (with a stderr warning) on any
 * non-positive or non-numeric input so typos don't silently run with defaults.
 * `max` clamps the result on the high end.
 */
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
 * Parse a [0, 1] confidence threshold. Returns `null` (auto-approve disabled)
 * when the flag is absent. Out-of-range or non-numeric values exit with an
 * error rather than silently disabling — auto-approval is high-stakes enough
 * (it bypasses human review) that a typo should fail loudly, not coast through
 * as "off."
 */
function parseAutoApproveThreshold(raw: unknown): number | null | { error: string } {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return {
      error: `Invalid --auto-approve-threshold "${String(raw)}". Must be a number in [0, 1].`,
    };
  }
  return n;
}

/**
 * Minimal concurrency pool: runs up to `concurrency` tasks in parallel,
 * resolves when all complete. No external dependency.
 */
async function runWithConcurrency<T>(
  concurrency: number,
  tasks: Array<() => Promise<T>>,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
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
  autoApprovedCandidates: number;
  autoApproveGraderErrors: number;
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
    autoApprovedCandidates: 0,
    autoApproveGraderErrors: 0,
  };
}

function sortedProviders(s: RunSummary) {
  return {
    used: [...s.providersUsed].sort(),
    skipped: [...s.providersSkipped].sort(),
  };
}

function summaryToJson(s: RunSummary, dryRun: boolean) {
  const { used, skipped } = sortedProviders(s);
  return {
    scanned: s.scanned,
    skipped_had_suggestion: s.skippedHadSuggestion,
    skipped_no_claim: s.skippedNoClaim,
    generated_for_records: s.generatedForRecords,
    suggestions_written: s.suggestionsWritten,
    provider_errors: s.providerErrors,
    cost_usd: Number(s.costUsd.toFixed(4)),
    budget_exhausted: s.budgetExhausted,
    providers_used: used,
    providers_skipped: skipped,
    auto_approved_candidates: s.autoApprovedCandidates,
    auto_approve_grader_errors: s.autoApproveGraderErrors,
    dry_run: dryRun,
  };
}

function formatSummary(s: RunSummary, dryRun: boolean): string {
  const { used, skipped } = sortedProviders(s);
  const usedList = used.join(', ') || '(none)';
  const skippedLine = skipped.length > 0
    ? `\nProviders skipped:      ${skipped.join(', ')}`
    : '';
  // Only include auto-approve lines when the feature was actually used
  // (i.e. at least one candidate was graded). Keeps default output unchanged.
  const autoApproveLines =
    s.autoApprovedCandidates > 0 || s.autoApproveGraderErrors > 0
      ? `\nAuto-approved:          ${s.autoApprovedCandidates}\nGrader errors:          ${s.autoApproveGraderErrors}`
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
Providers used:         ${usedList}${skippedLine}${autoApproveLines}`
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
  const limit = parseBoundedInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT, 'limit');
  const budgetCap = parsePositiveFloat(options.budget, DEFAULT_BUDGET_USD, 'budget');
  const maxCandidates = parseBoundedInt(
    options['max-candidates'] ?? options.maxCandidates,
    DEFAULT_MAX_CANDIDATES,
    MAX_CANDIDATES_PER_RECORD,
    'max-candidates',
  );
  const recordTypeFilter = options.type?.trim() || undefined;
  const entityFilter = options.entity?.trim() || undefined;
  const verdictFilter = (options.verdict?.trim() || DEFAULT_VERDICT).toLowerCase();
  if (!ALLOWED_SUGGEST_VERDICTS.has(verdictFilter)) {
    return {
      exitCode: 1,
      output: `Invalid --verdict "${verdictFilter}". Must be one of: ${[...ALLOWED_SUGGEST_VERDICTS].sort().join(', ')}`,
    };
  }
  const dryRun = Boolean(options['dry-run'] ?? options.dryRun);
  const skipExisting = options['skip-existing'] ?? options.skipExisting ?? true;
  const isJson = Boolean(options.json || options.ci);

  // Auto-approve threshold is opt-in — absence keeps the historical
  // status='pending' behavior. Any non-empty value is parsed strictly:
  // out-of-range or non-numeric values fail the command rather than
  // silently disabling, because a typo here would invisibly route a
  // sweep past the human-review queue.
  const thresholdParsed = parseAutoApproveThreshold(
    options['auto-approve-threshold'] ?? options.autoApproveThreshold,
  );
  if (thresholdParsed !== null && typeof thresholdParsed === 'object') {
    return { exitCode: 1, output: thresholdParsed.error };
  }
  const autoApproveThreshold: number | null = thresholdParsed;
  const autoApproveModel =
    (options['auto-approve-model'] ?? options.autoApproveModel)?.trim() ||
    DEFAULT_GRADER_MODEL;

  // Build the LLM client once and reuse across all grader calls; the alternative
  // (one new client per candidate) is wasteful for sweeps that grade thousands
  // of suggestions. `required: false` keeps the grader's fail-closed contract:
  // a missing key returns a null client and gradeSuggestion handles it itself.
  const graderClient =
    autoApproveThreshold !== null
      ? createAnthropicClient({ required: false })
      : null;
  if (autoApproveThreshold !== null && !graderClient) {
    // The user explicitly asked for auto-approval but the key isn't set, so
    // every candidate will fail-closed to 'pending'. Warn loudly so they
    // don't read a clean run summary and assume the grader did its job.
    process.stderr.write(
      'warning: --auto-approve-threshold is set but ANTHROPIC_BILLING_KEY is missing — every candidate will fail-closed to status=pending\n',
    );
  }

  const log = (msg: string) => { if (!isJson) console.log(msg); };

  log(`Sourcing Suggest URLs (QUA-64)`);
  log(`  verdict:        ${verdictFilter}`);
  log(`  limit:          ${limit}`);
  log(`  budget:         $${budgetCap.toFixed(2)}`);
  log(`  max-candidates: ${maxCandidates}`);
  if (recordTypeFilter) log(`  record type:    ${recordTypeFilter}`);
  if (entityFilter) log(`  entity:         ${entityFilter}`);
  if (autoApproveThreshold !== null) {
    log(`  auto-approve:   threshold=${autoApproveThreshold} model=${autoApproveModel}`);
  }
  if (dryRun) log(`  dry-run:        yes`);
  log('');

  const summary = makeSummary();

  const verdictsResult = await listVerdicts({
    verdict: verdictFilter,
    recordType: recordTypeFilter,
    limit,
  });
  if (!verdictsResult.ok) {
    return {
      exitCode: 1,
      output: `Failed to list ${verdictFilter} verdicts: ${verdictsResult.message ?? 'unknown error'}`,
    };
  }

  const verdictRows = entityFilter
    ? verdictsResult.data.verdicts.filter(
        (v) =>
          v.entityId === entityFilter ||
          (v.entityDisplayName ?? '').toLowerCase() === entityFilter.toLowerCase(),
      )
    : verdictsResult.data.verdicts;

  log(`Fetched ${verdictRows.length} ${verdictFilter} verdict(s).`);

  if (verdictRows.length === 0) {
    const output = isJson
      ? JSON.stringify({ summary: summaryToJson(summary, dryRun) })
      : `No ${verdictFilter} verdicts matched.`;
    return { exitCode: 0, output };
  }

  const pendingKeys = skipExisting
    ? await fetchPendingRecordKeys(recordTypeFilter, log)
    : new Set<string>();

  // Pre-compute claim/entity text and the skip verdict so the pre-fetch
  // filter and the per-task loop agree without duplicating logic.
  type PreparedRow = {
    v: (typeof verdictRows)[number];
    claimText: string;
    entityName: string;
    skipReason: 'no-claim' | 'had-suggestion' | null;
  };
  const prepared: PreparedRow[] = verdictRows.map((v) => {
    const claimText = v.reasoning?.trim() || v.displayName?.trim() || '';
    const entityName =
      v.entityDisplayName?.trim() || v.entityId?.trim() || v.displayName?.trim() || '';
    let skipReason: PreparedRow['skipReason'] = null;
    if (!claimText || !entityName) skipReason = 'no-claim';
    else if (skipExisting && pendingKeys.has(`${v.recordType}|${v.recordId}`))
      skipReason = 'had-suggestion';
    return { v, claimText, entityName, skipReason };
  });

  // Batch-fetch evidence once before the per-record task loop instead
  // of N calls inside it. Only fetch for rows we will actually process.
  const needsEvidence = prepared.filter((p) => p.skipReason === null);
  const existingUrlByKey = new Map<string, string | null>();
  for (let i = 0; i < needsEvidence.length; i += MAX_EVIDENCE_BY_RECORDS) {
    const chunk = needsEvidence.slice(i, i + MAX_EVIDENCE_BY_RECORDS);
    const evidenceRes = await getEvidenceByRecords(
      chunk.map((p) => ({ recordType: p.v.recordType, recordId: p.v.recordId })),
      { limitPerRecord: 5 },
    );
    if (!evidenceRes.ok) {
      return {
        exitCode: 1,
        output: `Failed to batch-fetch evidence: ${evidenceRes.message ?? 'unknown error'}`,
      };
    }
    for (const [key, rows] of Object.entries(evidenceRes.data.evidenceByKey)) {
      existingUrlByKey.set(key, rows.find((e) => e.sourceUrl)?.sourceUrl ?? null);
    }
  }

  const toUpsert: Parameters<typeof upsertUrlSuggestions>[0] = [];

  const tasks = prepared.map((p) => async () => {
    const { v, claimText, entityName, skipReason } = p;
    summary.scanned++;

    // Shared budget gate: once tripped, pending tasks short-circuit without
    // calling the paid providers. Tasks already in flight will still finish.
    if (summary.costUsd >= budgetCap) {
      if (!summary.budgetExhausted) {
        summary.budgetExhausted = true;
        log(`Budget reached ($${summary.costUsd.toFixed(4)} >= $${budgetCap.toFixed(2)}); stopping new work.`);
      }
      return;
    }

    if (skipReason === 'no-claim') {
      summary.skippedNoClaim++;
      return;
    }
    if (skipReason === 'had-suggestion') {
      summary.skippedHadSuggestion++;
      return;
    }

    const existingUrl = existingUrlByKey.get(evidenceRecordKey(v.recordType, v.recordId)) ?? null;

    if (dryRun) {
      log(`  [dry-run] ${v.recordType}/${v.recordId} field=${v.fieldName ?? '(row)'} entity="${entityName.slice(0, 40)}"`);
      summary.generatedForRecords++;
      return;
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

    if (result.candidates.length === 0) return;
    summary.generatedForRecords++;

    // When auto-approval is on, grade each candidate via a cheap LLM and
    // promote ≥threshold to `auto_verified`. Grader failures fall through
    // to `pending` (fail-closed). The grader is per-candidate (not
    // per-record) because the same record may have one strong + two weak
    // candidates — we want only the strong one promoted.
    if (autoApproveThreshold !== null) {
      const threshold = autoApproveThreshold; // narrow for the inner loop
      // Sequential grading inside a record. Records still run in parallel
      // via the outer runWithConcurrency, so the effective LLM concurrency
      // is bounded by DEFAULT_CONCURRENCY (5), not by N records × M
      // candidates. With max-candidates=10 and 5 records in flight, a
      // Promise.all here would fire up to 50 simultaneous Haiku calls and
      // bump into Anthropic rate limits at scale.
      const outcomes: GraderOutcome[] = [];
      for (const cand of result.candidates) {
        outcomes.push(
          await gradeSuggestion(
            {
              entityName,
              claimText,
              fieldName: v.fieldName ?? null,
              candidate: { url: cand.url, title: cand.title, snippet: cand.snippet },
            },
            // Pass the shared client when present; null means the key was
            // missing at startup, in which case the grader's own
            // fail-closed branch handles it.
            graderClient
              ? { model: autoApproveModel, client: graderClient }
              : { model: autoApproveModel },
          ),
        );
      }
      // Roll grader spend into the run-wide cost meter so `--budget`
      // accounts for it and the summary's "Cost:" line is honest.
      for (const o of outcomes) summary.costUsd += o.costUsd;

      for (let i = 0; i < result.candidates.length; i++) {
        const cand = result.candidates[i];
        const outcome = outcomes[i];
        // Audit-trail rule: only emit `notes` when we are actively
        // promoting this row to `auto_verified`. Below-threshold and
        // grader-error cases must NOT overwrite an existing row's notes
        // — the server's `notes = COALESCE(EXCLUDED.notes, ...)` clause
        // preserves prior notes only when EXCLUDED.notes is absent. If
        // we sent a "below-threshold" note here for a row that was
        // previously promoted (status preserved by the server's CASE),
        // its original "auto-approve" audit note would be silently
        // overwritten while status stayed `auto_verified` — a
        // contradictory state. Net effect: pending/error rows carry no
        // grader trace in the row itself, but the run summary's
        // auto_approve counts give the aggregate visibility.
        let status: 'pending' | 'auto_verified' = 'pending';
        let notes: string | undefined;
        if (outcome.ok) {
          if (outcome.confidence >= threshold) {
            status = 'auto_verified';
            summary.autoApprovedCandidates++;
            notes = `auto-approve: confidence=${outcome.confidence.toFixed(2)} model=${autoApproveModel} reasoning=${outcome.reasoning.slice(0, MAX_REASONING_CHARS)}`;
          }
        } else {
          summary.autoApproveGraderErrors++;
        }
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
          status,
          ...(notes !== undefined && { notes }),
        });
      }
      return;
    }

    // Auto-approve disabled: simple loop, no grader, all rows pending.
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
  });

  await runWithConcurrency(DEFAULT_CONCURRENCY, tasks);

  // Route enforces MAX_BATCH=200; chunk at 100 for safe headroom.
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
Sourcing Suggest URLs — auto-suggest better source URLs for weak-URL verdicts

Usage:
  crux sourcing-suggest-urls [options]

Options:
  --verdict=X            Verdict type to sweep (default: ${DEFAULT_VERDICT}).
                         Allowed: ${[...ALLOWED_SUGGEST_VERDICTS].sort().join(', ')}.
  --limit=N              Max verdicts to scan (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})
  --budget=N             Soft cap in USD on search-provider spend (default: $${DEFAULT_BUDGET_USD.toFixed(2)}).
                         Checked before each record — a single in-flight call can overshoot.
  --type=X               Filter by record type (e.g., fact, grant, personnel)
  --entity=X             Filter by entityId or entityDisplayName
  --max-candidates=N     Candidates per record (default: ${DEFAULT_MAX_CANDIDATES}, max: ${MAX_CANDIDATES_PER_RECORD})
  --skip-existing        Skip records with existing pending suggestions (default: on)
  --auto-approve-threshold=N   LLM-grade each candidate (title+snippet only; no fetch)
                         and write status='auto_verified' for confidence >= N (0..1).
                         Default: off (all suggestions stay 'pending'). Grader failures
                         fail-closed to 'pending'.
  --auto-approve-model=X       Override the grader model (default: ${DEFAULT_GRADER_MODEL}).
  --dry-run              Enumerate records without calling providers or writing
  --json / --ci          Machine-readable JSON output

Workflow:
  1. Lists verdicts with verdict=<--verdict> from /api/sourcing/verdicts.
  2. Runs web search (Exa + Perplexity) for the claim + entity name.
  3. Batch-upserts candidates to /api/sourcing/url-suggestions for human review
     or auto-recheck. Human decisions (approved/rejected) are preserved on re-runs.

Requires EXA_API_KEY and/or OPENROUTER_API_KEY for URL discovery. Missing keys
degrade gracefully (--auto-approve-threshold additionally requires
ANTHROPIC_BILLING_KEY; missing it fails-closed: every grade returns "pending").
Requires WIKI_SERVER_ENV=prod in agent slots.
`.trim();
}

