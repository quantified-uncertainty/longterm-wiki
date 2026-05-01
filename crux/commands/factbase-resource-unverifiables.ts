/**
 * FactBase Resource-Unverifiables Wrapper — QUA-934
 *
 * Wraps the QUA-926 source-discover engine in a "replace weak sources" loop
 * that targets FactBase facts whose latest verdict is `unverifiable` — facts
 * that already carry a `source:` URL but the URL doesn't actually contain the
 * claim (~444 such facts at filing time).
 *
 * Pipeline (per fact):
 *   1. Filter: facts where (a) `fact.source` is set AND (b) the fact's row-
 *      level verdict is `unverifiable` (queried from the wiki-server). Inverse
 *      facts and `verifiable:false` properties are skipped, same as
 *      backfill-sources (QUA-933).
 *   2. Discover: call `discoverSourceForFact` (real-time) or
 *      `buildDiscoveryBatchRequest` (`--batch`), passing the *current* source
 *      URL via `existingSourceUrl` so the prompt asks the LLM "is this URL
 *      still authoritative, or did you find better candidates?"
 *   3. Apply: when `result.best !== null` AND `result.best !== existingSourceUrl`
 *      AND confidence ≥ threshold, **replace** the URL in YAML via
 *      `updateFactMetaById` with `overwriteExisting: true`. Annotate notes
 *      with `[auto-replaced by qua-934]`. Skipping the write when the engine
 *      either confirms the existing URL or finds no qualifying candidate.
 *   4. Triage: for facts where no replacement happened, append a human-readable
 *      block to a manual-review file so an operator can review.
 *   5. Verify chain: after a successful replacement, reload the graph and run
 *      the existing fact-sourcing pipeline (factbase-sourcing.ts) inline on
 *      the freshly-resourced facts so the new verdict lands in the same run.
 *
 * Command:
 *   crux fb resource-unverifiables --budget=N [--batch] [--dry-run] [--apply]
 *                                  [--manual-review=<path>] [--no-verify-chain]
 *
 * Defaults: --dry-run; require explicit --apply to write or to emit the
 *           manual-review file.
 *
 * Key difference vs `crux fb backfill-sources` (QUA-933):
 *   - Backfill targets NULL sources. This command targets facts that HAVE a
 *     source but earned an `unverifiable` verdict.
 *   - The engine receives the existing URL so it can demote it.
 *   - YAML writes overwrite the existing source (the existing one is being
 *     demoted as weak), via `overwriteExisting: true`.
 *   - "No improvement found" is a real outcome — the fact goes to a manual-
 *     review list instead of becoming a YAML write.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { formatFactValue } from '../../packages/factbase/src/format.ts';
import type { Entity, Fact, Property } from '../../packages/factbase/src/types.ts';
import { loadGraphFull, resolveEntity, KB_DATA_DIR } from '../lib/factbase-loader.ts';
import type { LoadedKB } from '../lib/factbase-loader.ts';
import {
  readEntityDocument,
  writeEntityDocument,
  updateFactMetaById,
  findEntityFilePath,
} from '../lib/factbase-writer.ts';
import {
  discoverSourceForFact,
  buildDiscoveryBatchRequest,
  parseDiscoveryResponse,
  extractTextFromMessage,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type DiscoverResult,
  type DiscoverCandidate,
} from '../lib/sourcing/source-discover.ts';
import {
  submitBatch,
  pollBatch,
  getBatchResults,
  type MessageBatch,
} from '../lib/anthropic-batch.ts';
import { createLlmClient } from '../lib/llm.ts';
import { listVerdicts } from '../lib/wiki-server/sourcing-client.ts';
import { sourcingCommand } from './factbase-sourcing.ts';

// ── Constants ────────────────────────────────────────────────────────

/** Default soft cap on USD spend per run. Per the ticket cost estimate
 * (444 facts × $0.02 batch ≈ $10), a $5 default keeps a default-flag run
 * to ~half the backlog so an accidental --apply doesn't burn the budget. */
const DEFAULT_BUDGET_USD = 5.0;

/** Default cap on facts processed in one run (independent of budget). */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 2000;

/** Real-time concurrency for non-batch mode. The engine uses web_search so
 * we keep this conservative to avoid Anthropic per-minute rate limits. */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

/** Estimated USD cost per discover call. Sonnet + ≤3 web searches lands here
 * empirically; matches QUA-933's per-call estimate. */
const ESTIMATED_REALTIME_COST_USD = 0.04;
const ESTIMATED_BATCH_COST_USD = 0.02;

/** Provenance string written to the fact's `notes:` field on auto-replacement.
 * Distinct from QUA-933's "[auto-discovered by qua-926]" so an operator
 * grepping the YAML can tell weak-source replacements apart from NULL-source
 * backfills. */
const PROVENANCE_NOTE = '[auto-replaced by qua-934]';

/** Polling cadence for --batch mode. Anthropic batches typically complete in
 * minutes for small-to-medium sizes; poll every 30s and bail after 1h. */
const BATCH_POLL_INTERVAL_MS = 30_000;
const BATCH_POLL_TIMEOUT_MS = 60 * 60 * 1_000;

/** Default path for the manual-review file when --manual-review is omitted.
 * Project-root-relative. Pass `-` to print to stdout instead. */
const DEFAULT_MANUAL_REVIEW_PATH = 'manual-review-qua-934.txt';

/** Page size for paginated listVerdicts. Matches the server's natural page
 * size (the route clamps to 200). */
const VERDICT_PAGE_SIZE = 200;

// ── Types ────────────────────────────────────────────────────────────

export interface ResourceUnverifiablesOptions extends BaseOptions {
  property?: string;
  entity?: string;
  /** No-op marker. Default behavior — only unverifiable facts are scanned. */
  verdict?: string;
  budget?: string;
  limit?: string;
  threshold?: string;
  concurrency?: string;
  batch?: boolean;
  apply?: boolean;
  'dry-run'?: boolean;
  dryRun?: boolean;
  'no-verify-chain'?: boolean;
  noVerifyChain?: boolean;
  'include-non-verifiable'?: boolean;
  includeNonVerifiable?: boolean;
  'manual-review'?: string;
  manualReview?: string;
  ci?: boolean;
  json?: boolean;
}

interface FactDiscovery {
  entity: Entity;
  fact: Fact;
  propertyName: string;
  formattedValue: string;
  existingSourceUrl: string;
  result: DiscoverResult | null;
  error?: string;
}

type WriteOutcome =
  | { kind: 'replaced'; from: string; to: string }
  | { kind: 'unchanged-best-equals-existing' }
  | { kind: 'no-better-candidate' }
  | { kind: 'engine-error'; error: string }
  | { kind: 'not-found' }
  | { kind: 'write-error'; error: string };

interface FactWriteResult {
  factId: string;
  entityId: string;
  outcome: WriteOutcome;
}

interface VerifySummary {
  attempted: number;
  succeeded: number;
  failed: number;
}

interface RunSummary {
  scanned: number;
  /** Engine returned a different URL than the existing one (worth replacing). */
  betterCandidatesFound: number;
  /** Engine returned best === null (no candidate met threshold). */
  noBest: number;
  /** Engine returned best === existingSourceUrl (LLM thinks current URL is fine). */
  bestEqualsExisting: number;
  engineErrors: number;
  writesAttempted: number;
  writesSucceeded: number;
  writesNotFound: number;
  writeErrors: number;
  manualReviewCount: number;
  verifyAttempted: number;
  verifySucceeded: number;
  verifyFailed: number;
  costUsd: number;
  budgetExhausted: boolean;
  unverifiableFactIdsFetched: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseBoundedInt(
  raw: unknown,
  fallback: number,
  max: number,
  flag: string,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`warning: ignoring --${flag}=${String(raw)} (expected positive integer)\n`);
    return fallback;
  }
  return Math.min(n, max);
}

function parsePositiveFloat(raw: unknown, fallback: number, flag: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`warning: ignoring --${flag}=${String(raw)} (expected positive number)\n`);
    return fallback;
  }
  return n;
}

function parseThreshold(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CONFIDENCE_THRESHOLD;
  const n = parseFloat(String(raw));
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    process.stderr.write(
      `warning: ignoring --threshold=${String(raw)} (must be in [0, 1]); using ${DEFAULT_CONFIDENCE_THRESHOLD}\n`,
    );
    return DEFAULT_CONFIDENCE_THRESHOLD;
  }
  return n;
}

function zeroSummary(): RunSummary {
  return {
    scanned: 0,
    betterCandidatesFound: 0,
    noBest: 0,
    bestEqualsExisting: 0,
    engineErrors: 0,
    writesAttempted: 0,
    writesSucceeded: 0,
    writesNotFound: 0,
    writeErrors: 0,
    manualReviewCount: 0,
    verifyAttempted: 0,
    verifySucceeded: 0,
    verifyFailed: 0,
    costUsd: 0,
    budgetExhausted: false,
    unverifiableFactIdsFetched: 0,
  };
}

/**
 * Build the engine input shape from a (kb, entity, fact) tuple. Mirrors the
 * helper of the same name in `factbase-backfill-sources.ts` (kept local
 * because adding `existingSourceUrl` would require a signature change to the
 * exported helper).
 */
export function makeDiscoverInput(
  kb: LoadedKB,
  entity: Entity,
  fact: Fact,
): {
  entity: Entity;
  fact: Fact;
  property: Property | undefined;
  formattedValue: string;
  propertyName: string;
} {
  const property = kb.graph.getProperty(fact.propertyId);
  const formattedValue = formatFactValue(fact, property, kb.graph);
  const propertyName = property?.name ?? fact.propertyId;
  return { entity, fact, property, formattedValue, propertyName };
}

/**
 * Minimal concurrency pool for real-time mode. Mirrors the helper in
 * `factbase-source-backfill.ts` / `factbase-backfill-sources.ts` — a third
 * copy is preferable to extracting a shared module just for this single
 * function.
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

// ── Verdict fetch ────────────────────────────────────────────────────

/**
 * Fetch every fact ID with a row-level `unverifiable` verdict from the
 * wiki-server. Skips per-field verdicts (`fieldName != null`) — fact verdicts
 * are row-level by convention. Paginates against `total` so we don't depend
 * on knowing the server's max page size.
 *
 * Exported for unit testing.
 *
 * Concurrency note: rows are sorted by `lastComputedAt desc`, so concurrent
 * verdict writes between page fetches can shift ordering and cause a few
 * skipped rows or duplicates across pages. Set deduplicates duplicates;
 * skipped rows mean a few facts fall out of scope on this run — wasted work
 * (re-scanned next run) but never incorrect output. Same trade-off as
 * `fetchVerdictRecordIds` in QUA-851.
 */
export async function fetchUnverifiableFactIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let offset = 0;
  while (true) {
    const res = await listVerdicts({
      recordType: 'fact',
      verdict: 'unverifiable',
      limit: VERDICT_PAGE_SIZE,
      offset,
    });
    if (!res.ok) {
      throw new Error(
        `wiki-server listVerdicts failed: ${res.message} (kind: ${res.error})`,
      );
    }
    for (const v of res.data.verdicts) {
      if (v.fieldName != null) continue; // skip per-field verdicts
      ids.add(v.recordId);
    }
    const fetchedSoFar = offset + res.data.verdicts.length;
    if (res.data.verdicts.length === 0 || fetchedSoFar >= res.data.total) break;
    offset = fetchedSoFar;
  }
  return ids;
}

// ── Fact filtering ───────────────────────────────────────────────────

/**
 * Collect FactBase facts that are candidates for "weak source replacement":
 *   - have a `source:` URL set
 *   - have an `unverifiable` row-level verdict (provided as `unverifiableIds`)
 *   - aren't inverse facts
 *   - aren't on `verifiable: false` properties (website, wikipedia-url, etc.)
 *     unless the caller passes `includeNonVerifiable`
 *
 * Editorial properties (description, notable-for) are NOT auto-skipped here
 * — backfill-sources skips them because they have no canonical URL, but
 * QUA-934 only acts on facts that ALREADY have a source and earned an
 * unverifiable verdict, so the property's editorial-ness is moot. If the
 * verdict is unverifiable, the source is wrong regardless of property type.
 *
 * Exported for unit testing.
 */
export function collectUnverifiableFacts(
  kb: LoadedKB,
  unverifiableIds: Set<string>,
  options: {
    entity?: string;
    property?: string;
    includeNonVerifiable?: boolean;
    limit?: number;
  },
): Array<{ entity: Entity; fact: Fact }> {
  const graph = kb.graph;

  const scanEntities: Entity[] = options.entity
    ? (() => {
        const resolved = resolveEntity(options.entity, kb);
        return resolved ? [resolved] : [];
      })()
    : graph.getAllEntities();

  const out: Array<{ entity: Entity; fact: Fact }> = [];

  for (const entity of scanEntities) {
    const facts = graph.getFacts(entity.id);
    for (const fact of facts) {
      if (fact.id.startsWith('inv_')) continue;
      if (!fact.source) continue;
      if (!unverifiableIds.has(fact.id)) continue;
      if (options.property && fact.propertyId !== options.property) continue;

      const property = graph.getProperty(fact.propertyId);
      if (property?.verifiable === false && !options.includeNonVerifiable) continue;

      out.push({ entity, fact });
      if (options.limit && out.length >= options.limit) return out;
    }
  }

  return out;
}

// ── Discovery: real-time path ────────────────────────────────────────

async function discoverRealtime(
  kb: LoadedKB,
  facts: Array<{ entity: Entity; fact: Fact }>,
  options: { threshold: number; budget: number; concurrency: number; log: (m: string) => void },
  summary: RunSummary,
): Promise<FactDiscovery[]> {
  const results: FactDiscovery[] = [];

  const tasks = facts.map(({ entity, fact }) => async () => {
    summary.scanned++;

    if (summary.costUsd + ESTIMATED_REALTIME_COST_USD > options.budget) {
      if (!summary.budgetExhausted) {
        summary.budgetExhausted = true;
        options.log(
          `Budget reached ($${summary.costUsd.toFixed(4)} + estimated $${ESTIMATED_REALTIME_COST_USD.toFixed(2)} > $${options.budget.toFixed(2)}); stopping new work.`,
        );
      }
      return;
    }

    const input = makeDiscoverInput(kb, entity, fact);
    const existingSourceUrl = fact.source ?? '';
    try {
      const result = await discoverSourceForFact(
        {
          entity,
          fact,
          property: input.property,
          formattedValue: input.formattedValue,
          existingSourceUrl,
        },
        { threshold: options.threshold },
      );
      summary.costUsd += result.costUsd;
      results.push({
        entity,
        fact,
        propertyName: input.propertyName,
        formattedValue: input.formattedValue,
        existingSourceUrl,
        result,
      });
      classifyDiscovery(result, existingSourceUrl, summary);
    } catch (e) {
      summary.engineErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        entity,
        fact,
        propertyName: input.propertyName,
        formattedValue: input.formattedValue,
        existingSourceUrl,
        result: null,
        error: msg,
      });
    }
  });

  await runWithConcurrency(options.concurrency, tasks);
  return results;
}

/**
 * Bucket a single engine result against the existing URL into the per-fact
 * outcome counters. Pure: no side effects beyond mutating `summary`.
 */
function classifyDiscovery(
  result: DiscoverResult,
  existingSourceUrl: string,
  summary: RunSummary,
): void {
  if (!result.best) {
    summary.noBest++;
  } else if (result.best === existingSourceUrl) {
    summary.bestEqualsExisting++;
  } else {
    summary.betterCandidatesFound++;
  }
}

// ── Discovery: batch path ────────────────────────────────────────────

async function discoverBatch(
  kb: LoadedKB,
  facts: Array<{ entity: Entity; fact: Fact }>,
  options: { threshold: number; budget: number; log: (m: string) => void },
  summary: RunSummary,
): Promise<FactDiscovery[]> {
  // Budget gate: estimate cost before submission. Batch is all-or-nothing —
  // we can't drip-feed once submitted, so cap up front.
  const estimatedCost = facts.length * ESTIMATED_BATCH_COST_USD;
  let inBudget = facts;
  if (estimatedCost > options.budget) {
    const maxByBudget = Math.floor(options.budget / ESTIMATED_BATCH_COST_USD);
    options.log(
      `Estimated batch cost $${estimatedCost.toFixed(2)} exceeds budget $${options.budget.toFixed(2)}; trimming to ${maxByBudget} facts.`,
    );
    inBudget = facts.slice(0, maxByBudget);
    summary.budgetExhausted = true;
  }

  if (inBudget.length === 0) return [];

  const customIdToFact = new Map<
    string,
    { entity: Entity; fact: Fact; propertyName: string; formattedValue: string; existingSourceUrl: string }
  >();
  const requests = inBudget.map(({ entity, fact }) => {
    const input = makeDiscoverInput(kb, entity, fact);
    const existingSourceUrl = fact.source ?? '';
    const req = buildDiscoveryBatchRequest(
      {
        entity,
        fact,
        property: input.property,
        formattedValue: input.formattedValue,
        existingSourceUrl,
      },
      { threshold: options.threshold },
    );
    customIdToFact.set(req.customId, {
      entity,
      fact,
      propertyName: input.propertyName,
      formattedValue: input.formattedValue,
      existingSourceUrl,
    });
    return req;
  });

  options.log(`Submitting batch of ${requests.length} discovery request(s) to Anthropic Batch API…`);
  const client = createLlmClient();
  const submitted: MessageBatch = await submitBatch(client, requests);
  options.log(
    `Batch ${submitted.id} submitted; polling every ${BATCH_POLL_INTERVAL_MS / 1000}s (timeout ${BATCH_POLL_TIMEOUT_MS / 60000} min)…`,
  );

  await pollBatch(client, submitted.id, {
    intervalMs: BATCH_POLL_INTERVAL_MS,
    timeoutMs: BATCH_POLL_TIMEOUT_MS,
    onPoll: (b) => {
      if (b.processing_status !== 'ended') {
        options.log(
          `  batch ${b.id}: ${b.processing_status} (counts: ${JSON.stringify(b.request_counts)})`,
        );
      }
    },
  });

  const responses = await getBatchResults(client, submitted.id);
  const results: FactDiscovery[] = [];

  for (const [customId, response] of responses) {
    const ctx = customIdToFact.get(customId);
    if (!ctx) {
      options.log(`  [warn] batch returned unknown customId: ${customId}`);
      continue;
    }
    summary.scanned++;

    if (response.result.type !== 'succeeded') {
      summary.engineErrors++;
      const errMsg =
        response.result.type === 'errored'
          ? response.result.error.error?.message ?? response.result.type
          : response.result.type;
      results.push({
        entity: ctx.entity,
        fact: ctx.fact,
        propertyName: ctx.propertyName,
        formattedValue: ctx.formattedValue,
        existingSourceUrl: ctx.existingSourceUrl,
        result: null,
        error: `batch ${response.result.type}: ${errMsg}`,
      });
      continue;
    }

    const text = extractTextFromMessage(response.result.message);
    const parsed = parseDiscoveryResponse(text, options.threshold);
    summary.costUsd += ESTIMATED_BATCH_COST_USD;
    const discoverResult: DiscoverResult = { ...parsed, costUsd: 0 };
    results.push({
      entity: ctx.entity,
      fact: ctx.fact,
      propertyName: ctx.propertyName,
      formattedValue: ctx.formattedValue,
      existingSourceUrl: ctx.existingSourceUrl,
      result: discoverResult,
    });
    classifyDiscovery(discoverResult, ctx.existingSourceUrl, summary);
  }

  return results;
}

// ── Apply: write to YAML ─────────────────────────────────────────────

/**
 * Decide which discoveries actually warrant a YAML write. A discovery is
 * "actionable" when the engine returned a `best` URL that is different from
 * the existing one. Discoveries with no `best`, or whose `best` matches the
 * existing URL, route to the manual-review list instead (the existing URL
 * stays as-is).
 *
 * Shared by `applyToYaml` and the dry-run path so the manual-review counts
 * are identical between the two modes.
 */
function isActionable(d: FactDiscovery): boolean {
  return Boolean(d.result?.best) && d.result!.best !== d.existingSourceUrl;
}

/**
 * Group actionable discoveries by entity, then read+write each entity's YAML
 * exactly once. Mirrors the strategy in `factbase-backfill-sources.ts` but
 * passes `overwriteExisting: true` so the existing (weak) URL is replaced.
 */
function applyToYaml(
  discoveries: FactDiscovery[],
  kb: LoadedKB,
  log: (m: string) => void,
  summary: RunSummary,
): FactWriteResult[] {
  const writes: FactWriteResult[] = [];
  const byEntity = new Map<
    string,
    Array<{ factId: string; from: string; to: string }>
  >();

  for (const d of discoveries) {
    if (!isActionable(d)) {
      // Non-actionable outcomes are tracked in the summary's per-bucket
      // counters (engineErrors, noBest, bestEqualsExisting) and surface in
      // the manual-review file. Don't double-count them as writes.
      continue;
    }
    const list = byEntity.get(d.entity.id);
    const next = { factId: d.fact.id, from: d.existingSourceUrl, to: d.result!.best! };
    if (list) list.push(next);
    else byEntity.set(d.entity.id, [next]);
  }

  for (const [entityId, updates] of byEntity) {
    summary.writesAttempted += updates.length;
    const slug = kb.filenameMap.get(entityId);
    if (!slug) {
      log(`  [warn] no filename for entity ${entityId} — skipping ${updates.length} write(s)`);
      for (const u of updates) {
        summary.writeErrors++;
        writes.push({
          factId: u.factId,
          entityId,
          outcome: { kind: 'write-error', error: `no filename for entity ${entityId}` },
        });
      }
      continue;
    }
    const filepath = findEntityFilePath(slug, KB_DATA_DIR);
    if (!filepath) {
      log(`  [warn] YAML file not found for ${slug} — skipping ${updates.length} write(s)`);
      for (const u of updates) {
        summary.writeErrors++;
        writes.push({
          factId: u.factId,
          entityId,
          outcome: { kind: 'write-error', error: `YAML file not found for ${slug}` },
        });
      }
      continue;
    }

    let doc;
    try {
      doc = readEntityDocument(filepath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  [error] read failed for ${slug}: ${msg}`);
      for (const u of updates) {
        summary.writeErrors++;
        writes.push({
          factId: u.factId,
          entityId,
          outcome: { kind: 'write-error', error: `read failed: ${msg}` },
        });
      }
      continue;
    }

    // Capture the index where THIS entity's writes start so the failure
    // re-classification below scans exactly this entity's outcomes — same
    // discipline as backfill-sources.ts's `entityWritesStartIdx` (regression
    // protection for mixed wrote/not-found in the same entity loop).
    const entityWritesStartIdx = writes.length;
    let changed = 0;
    for (const { factId, from, to } of updates) {
      const status = updateFactMetaById(
        doc,
        factId,
        { source: to, notes: PROVENANCE_NOTE },
        { overwriteExisting: true },
      );
      if (status === 'updated') {
        changed++;
        summary.writesSucceeded++;
        writes.push({ factId, entityId, outcome: { kind: 'replaced', from, to } });
      } else {
        // 'skipped-existing' is impossible here because we passed
        // overwriteExisting: true. The remaining no-op is 'not-found' (fact
        // ID not in YAML — slug rename, atomic-rename lag, fact-id collision).
        summary.writesNotFound++;
        writes.push({ factId, entityId, outcome: { kind: 'not-found' } });
      }
    }

    if (changed > 0) {
      try {
        writeEntityDocument(filepath, doc);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  [error] write failed for ${slug}: ${msg}`);
        for (let i = entityWritesStartIdx; i < writes.length; i++) {
          if (writes[i].outcome.kind === 'replaced') {
            summary.writesSucceeded--;
            summary.writeErrors++;
            writes[i] = {
              ...writes[i],
              outcome: { kind: 'write-error', error: `write failed: ${msg}` },
            };
          }
        }
      }
    }
  }

  return writes;
}

// ── Manual-review output ─────────────────────────────────────────────

interface ManualReviewEntry {
  entity: Entity;
  fact: Fact;
  propertyName: string;
  formattedValue: string;
  existingSourceUrl: string;
  reason: string;
  candidates: DiscoverCandidate[];
}

function buildManualReviewEntries(discoveries: FactDiscovery[]): ManualReviewEntry[] {
  const out: ManualReviewEntry[] = [];
  for (const d of discoveries) {
    if (isActionable(d)) continue;
    const reason = d.error
      ? `engine error: ${d.error}`
      : !d.result
        ? 'engine returned no result'
        : !d.result.best
          ? `no candidate met threshold — ${d.result.reason}`
          : `engine confirmed existing URL is best — ${d.result.reason}`;
    out.push({
      entity: d.entity,
      fact: d.fact,
      propertyName: d.propertyName,
      formattedValue: d.formattedValue,
      existingSourceUrl: d.existingSourceUrl,
      reason,
      candidates: d.result?.candidates ?? [],
    });
  }
  return out;
}

function formatManualReview(
  entries: ManualReviewEntry[],
  meta: { startedAt: string; mode: 'apply' | 'dry-run'; total: number; budget: number },
): string {
  const lines: string[] = [];
  lines.push('# QUA-934 — Manual Review');
  lines.push(`# Generated: ${meta.startedAt}`);
  lines.push(`# Mode: ${meta.mode}`);
  lines.push(`# Facts processed: ${meta.total}; budget: $${meta.budget.toFixed(2)}`);
  lines.push(`# Entries below are facts where no replacement source was found.`);
  lines.push('');
  for (const e of entries) {
    const asOf = e.fact.asOf ? ` [${e.fact.asOf}]` : '';
    lines.push(`## ${e.entity.name} (${e.entity.id}) — ${e.propertyName}${asOf}`);
    lines.push(`fact:    ${e.fact.id}`);
    lines.push(`value:   ${e.formattedValue}`);
    lines.push(`current: ${e.existingSourceUrl}`);
    lines.push(`reason:  ${e.reason}`);
    if (e.candidates.length > 0) {
      lines.push('candidates:');
      for (const c of e.candidates) {
        lines.push(`  - [${c.confidence.toFixed(2)}] ${c.url}`);
        if (c.summary) lines.push(`    ${c.summary}`);
      }
    } else {
      lines.push('candidates: (none)');
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Resolve `--manual-review=<path>` to one of three modes:
 *   - `null` → don't write a file (used in dry-run when the user didn't pass
 *     an explicit path; the report is still printed to the report body).
 *   - `'-'`  → emit to stdout via the returned report body, not a file.
 *   - else   → an absolute path on disk.
 *
 * `apply: true` always returns a file path (defaulting if unset) so the
 * triage list is durable. `dry-run` only returns a path if the user asked
 * for one explicitly.
 */
function resolveManualReviewTarget(
  raw: string | undefined,
  apply: boolean,
): string | null {
  if (raw === '-') return '-';
  if (raw && raw.length > 0) return resolve(raw);
  if (apply) return resolve(DEFAULT_MANUAL_REVIEW_PATH);
  return null;
}

function writeManualReviewFile(path: string, content: string, log: (m: string) => void): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, content, 'utf-8');
    log(`Manual-review report written to ${path}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`  [warn] failed to write manual-review file ${path}: ${msg}`);
  }
}

// ── Verify chain ─────────────────────────────────────────────────────

/**
 * Same no-op detection as `factbase-backfill-sources.ts` — see QUA-963 for
 * the regression that motivated it. `sourcingCommand` returns exit 0 + a
 * "Fact not found or has no source URL" string when its post-write reload
 * doesn't see the fact (race, slug rename, atomic-rename lag, fact-id
 * collision). The wrapper must NOT count those as `succeeded` because zero
 * verdicts actually landed.
 */
const VERIFY_NO_OP_PATTERNS = [
  /^Fact not found or has no source URL:/,
  /^No facts with source URLs found/,
];

function isVerifyNoOp(output: string | undefined): boolean {
  if (!output) return false;
  for (const pat of VERIFY_NO_OP_PATTERNS) {
    if (pat.test(output)) return true;
  }
  return false;
}

async function runVerifyChain(
  factIds: string[],
  log: (m: string) => void,
): Promise<VerifySummary> {
  const summary: VerifySummary = { attempted: 0, succeeded: 0, failed: 0 };
  if (factIds.length === 0) return summary;

  log(`Running verify chain on ${factIds.length} freshly-replaced fact(s)…`);
  for (const factId of factIds) {
    summary.attempted++;
    try {
      const res = await sourcingCommand([], { fact: factId });
      if (res.exitCode === 0 && !isVerifyNoOp(res.output)) {
        summary.succeeded++;
      } else if (res.exitCode === 0 && isVerifyNoOp(res.output)) {
        summary.failed++;
        log(`  [verify] ${factId}: no-op (verifier did not see the fact post-write — race, collision, or missing source)`);
      } else {
        summary.failed++;
        log(`  [verify] ${factId}: exit ${res.exitCode}`);
      }
    } catch (e) {
      summary.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      log(`  [verify] ${factId}: ${msg}`);
    }
  }
  return summary;
}

// ── Main command ────────────────────────────────────────────────────

async function resourceUnverifiablesCommand(
  _args: string[],
  options: ResourceUnverifiablesOptions,
): Promise<CommandResult> {
  const limit = parseBoundedInt(options.limit, DEFAULT_LIMIT, MAX_LIMIT, 'limit');
  const budget = parsePositiveFloat(options.budget, DEFAULT_BUDGET_USD, 'budget');
  const threshold = parseThreshold(options.threshold);
  const concurrency = parseBoundedInt(
    options.concurrency,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
    'concurrency',
  );
  const apply = Boolean(options.apply);
  const dryRun = !apply;
  const useBatch = Boolean(options.batch);
  const skipVerifyChain = Boolean(options['no-verify-chain'] ?? options.noVerifyChain);
  const includeNonVerifiable = Boolean(
    options['include-non-verifiable'] ?? options.includeNonVerifiable,
  );
  const propertyFilter = options.property?.trim() || undefined;
  const entityFilter = options.entity?.trim() || undefined;
  const isJson = Boolean(options.ci || options.json);
  const manualReviewArg =
    typeof options['manual-review'] === 'string'
      ? options['manual-review']
      : typeof options.manualReview === 'string'
        ? options.manualReview
        : undefined;
  const manualReviewTarget = resolveManualReviewTarget(manualReviewArg, apply);

  const log = (msg: string) => {
    if (!isJson) console.log(msg);
  };

  // Phase 1: fetch unverifiable fact IDs from the wiki-server.
  log(`FactBase resource-unverifiables (QUA-934 — wraps QUA-926 engine)`);
  log(`  mode:           ${apply ? 'APPLY' : 'dry-run'}`);
  log(`  pipeline:       ${useBatch ? 'Anthropic Batch API (50% off)' : 'real-time LLM'}`);
  log(`  limit:          ${limit}`);
  log(`  budget:         $${budget.toFixed(2)}`);
  log(`  threshold:      ${threshold.toFixed(2)}`);
  if (!useBatch) log(`  concurrency:    ${concurrency}`);
  if (propertyFilter) log(`  property:       ${propertyFilter}`);
  if (entityFilter) log(`  entity:         ${entityFilter}`);
  if (includeNonVerifiable) log(`  include-non-verifiable: yes`);
  if (manualReviewTarget) {
    log(`  manual-review:  ${manualReviewTarget === '-' ? '(stdout)' : manualReviewTarget}`);
  }

  let unverifiableIds: Set<string>;
  try {
    unverifiableIds = await fetchUnverifiableFactIds();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      exitCode: 1,
      output: isJson
        ? JSON.stringify({ error: `failed to fetch unverifiable verdicts: ${msg}` })
        : `error: failed to fetch unverifiable verdicts from wiki-server: ${msg}`,
    };
  }
  log(`  unverifiable fact ids fetched: ${unverifiableIds.size}`);

  const kb = await loadGraphFull();
  const facts = collectUnverifiableFacts(kb, unverifiableIds, {
    entity: entityFilter,
    property: propertyFilter,
    includeNonVerifiable,
    limit,
  });
  log(`  facts to process: ${facts.length}`);
  log('');

  const summary = zeroSummary();
  summary.unverifiableFactIdsFetched = unverifiableIds.size;

  if (facts.length === 0) {
    const empty = isJson
      ? JSON.stringify({
          summary: { ...summary, apply, batch: useBatch },
          results: [],
          writes: [],
          manualReview: [],
        })
      : 'No unverifiable facts match the given filters.';
    return { exitCode: 0, output: empty };
  }

  // Phase 2: discover.
  const discoveries = useBatch
    ? await discoverBatch(kb, facts, { threshold, budget, log }, summary)
    : await discoverRealtime(kb, facts, { threshold, budget, concurrency, log }, summary);

  // Phase 3: apply (replace) when actionable.
  let writes: FactWriteResult[] = [];
  if (apply) {
    writes = applyToYaml(discoveries, kb, log, summary);
  }

  // Phase 4: assemble the manual-review list (always — the report is shown
  // even in dry-run so the user sees what would be triaged on --apply).
  const manualReview = buildManualReviewEntries(discoveries);
  summary.manualReviewCount = manualReview.length;

  if (manualReviewTarget && manualReviewTarget !== '-') {
    const startedAt = new Date().toISOString();
    const content = formatManualReview(manualReview, {
      startedAt,
      mode: apply ? 'apply' : 'dry-run',
      total: facts.length,
      budget,
    });
    writeManualReviewFile(manualReviewTarget, content, log);
  }

  // Phase 5: verify chain on facts that physically replaced.
  if (apply && !skipVerifyChain) {
    const replacedFactIds = writes
      .filter((w) => w.outcome.kind === 'replaced')
      .map((w) => w.factId);
    const verify = await runVerifyChain(replacedFactIds, log);
    summary.verifyAttempted = verify.attempted;
    summary.verifySucceeded = verify.succeeded;
    summary.verifyFailed = verify.failed;
  }

  // Phase 6: render output.
  if (isJson) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        summary: {
          ...summary,
          costUsd: Number(summary.costUsd.toFixed(4)),
          apply,
          batch: useBatch,
          verifyChainSkipped: skipVerifyChain,
        },
        results: discoveries.map((d) => ({
          factId: d.fact.id,
          entityId: d.entity.id,
          entityName: d.entity.name,
          propertyId: d.fact.propertyId,
          propertyName: d.propertyName,
          value: d.formattedValue,
          asOf: d.fact.asOf ?? null,
          existingSourceUrl: d.existingSourceUrl,
          best: d.result?.best ?? null,
          candidateCount: d.result?.candidates.length ?? 0,
          reason: d.result?.reason ?? d.error ?? '',
          actionable: isActionable(d),
          error: d.error ?? null,
        })),
        writes: writes.map((w) => ({
          factId: w.factId,
          entityId: w.entityId,
          outcome: w.outcome.kind,
          ...(w.outcome.kind === 'replaced' && { from: w.outcome.from, to: w.outcome.to }),
          ...(w.outcome.kind === 'write-error' && { error: w.outcome.error }),
        })),
        manualReview: manualReview.map((m) => ({
          factId: m.fact.id,
          entityId: m.entity.id,
          entityName: m.entity.name,
          propertyId: m.fact.propertyId,
          propertyName: m.propertyName,
          value: m.formattedValue,
          existingSourceUrl: m.existingSourceUrl,
          reason: m.reason,
          candidates: m.candidates,
        })),
      }),
    };
  }

  const reportBody = formatReport(discoveries, writes, manualReview, summary, apply, dryRun);
  if (manualReviewTarget === '-') {
    const stdoutManual = formatManualReview(manualReview, {
      startedAt: new Date().toISOString(),
      mode: apply ? 'apply' : 'dry-run',
      total: facts.length,
      budget,
    });
    return { exitCode: 0, output: `${reportBody}\n\n${stdoutManual}` };
  }
  return { exitCode: 0, output: reportBody };
}

function formatReport(
  discoveries: FactDiscovery[],
  writes: FactWriteResult[],
  manualReview: ManualReviewEntry[],
  summary: RunSummary,
  apply: boolean,
  dryRun: boolean,
): string {
  const lines: string[] = [];

  const byEntity = new Map<string, FactDiscovery[]>();
  for (const d of discoveries) {
    const existing = byEntity.get(d.entity.id);
    if (existing) existing.push(d);
    else byEntity.set(d.entity.id, [d]);
  }

  for (const [, entries] of byEntity) {
    const entity = entries[0].entity;
    lines.push(`\x1b[1m${entity.name}\x1b[0m (${entity.id}) — ${entries.length} unverifiable fact(s)`);
    for (const d of entries) {
      const asOf = d.fact.asOf ? ` [${d.fact.asOf}]` : '';
      lines.push(`  ${d.propertyName}: ${d.formattedValue}${asOf}  (${d.fact.id})`);
      lines.push(`    current: ${d.existingSourceUrl}`);
      if (d.error) {
        lines.push(`    \x1b[31m✗ engine error: ${d.error}\x1b[0m`);
      } else if (!d.result || d.result.candidates.length === 0) {
        lines.push(`    \x1b[33m(no candidates discovered)\x1b[0m`);
      } else {
        for (const c of d.result.candidates) {
          const isBest = c.url === d.result.best;
          const isExisting = c.url === d.existingSourceUrl;
          const marker = isBest ? '\x1b[32m★\x1b[0m' : isExisting ? '\x1b[2m=\x1b[0m' : ' ';
          lines.push(`    ${marker} [${c.confidence.toFixed(2)}] ${c.url}`);
        }
        if (!d.result.best) {
          lines.push(`    \x1b[33m(no candidate met threshold; reason: ${d.result.reason})\x1b[0m`);
        } else if (d.result.best === d.existingSourceUrl) {
          lines.push(`    \x1b[33m(engine confirmed existing URL is best — ${d.result.reason})\x1b[0m`);
        } else {
          lines.push(`    \x1b[32m→ replace with ${d.result.best}\x1b[0m`);
        }
      }
    }
    lines.push('');
  }

  lines.push('=== Summary ===');
  lines.push(`Unverifiable IDs fetched:  ${summary.unverifiableFactIdsFetched}`);
  lines.push(`Scanned:                   ${summary.scanned}`);
  lines.push(`Better candidate found:    ${summary.betterCandidatesFound}`);
  lines.push(`Best === existing URL:     ${summary.bestEqualsExisting}`);
  lines.push(`No best candidate:         ${summary.noBest}`);
  lines.push(`Engine errors:             ${summary.engineErrors}`);
  if (apply) {
    lines.push(`Writes attempted:          ${summary.writesAttempted}`);
    lines.push(`Writes succeeded:          ${summary.writesSucceeded}`);
    lines.push(`Not found in YAML:         ${summary.writesNotFound}`);
    lines.push(`Write errors:              ${summary.writeErrors}`);
    lines.push(`Verify attempted:          ${summary.verifyAttempted}`);
    lines.push(`Verify succeeded:          ${summary.verifySucceeded}`);
    lines.push(`Verify failed:             ${summary.verifyFailed}`);
  }
  lines.push(`Manual-review entries:     ${manualReview.length}`);
  lines.push(`Cost (est.):               $${summary.costUsd.toFixed(4)}`);
  lines.push(`Budget exhausted:          ${summary.budgetExhausted ? 'yes' : 'no'}`);
  lines.push('');

  if (dryRun) {
    lines.push('\x1b[2mRun with --apply to replace weak source URLs in YAML, write the manual-review file, and chain into verify.\x1b[0m');
  } else if (writes.length > 0 && summary.writesSucceeded === 0) {
    lines.push('\x1b[33mNo URLs replaced (all discoveries either had no `best` or the engine confirmed the existing URL).\x1b[0m');
  }
  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: resourceUnverifiablesCommand,
};

export function getHelp(): string {
  return `
FactBase Resource-Unverifiables (QUA-934) — wraps the QUA-926 source-discover
engine to replace weak source URLs on facts with verdict=unverifiable, then
chains into verify.

Usage:
  crux fb resource-unverifiables [options]

Options:
  --property=<id>            Filter to one property (e.g. born-year, education)
  --entity=<slug|stableId>   Filter to one entity
  --verdict=unverifiable     (no-op marker) Default — only unverifiable verdicts are scanned
  --limit=N                  Cap on facts processed (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})
  --budget=N                 Soft cap in USD on engine spend (default: $${DEFAULT_BUDGET_USD.toFixed(2)})
  --threshold=N              Confidence floor for "best" pick (0-1, default: ${DEFAULT_CONFIDENCE_THRESHOLD})
  --concurrency=N            Real-time concurrency (default: ${DEFAULT_CONCURRENCY}, max: ${MAX_CONCURRENCY}). Ignored with --batch.
  --batch                    Use Anthropic Batch API (50% cheaper, async; bounded poll up to 1h)
  --apply                    Write replaced URLs to YAML, write manual-review file, chain into verify (default: dry-run)
  --no-verify-chain          Skip the inline verify-chain after writes (apply mode only)
  --include-non-verifiable   Scan properties with verifiable:false (website, etc.); off by default
  --manual-review=<path>     Path to write the manual-review triage list. Default: ./${DEFAULT_MANUAL_REVIEW_PATH}
                             on --apply, suppressed on --dry-run unless explicit. Pass "-" for stdout.
  --json / --ci              Machine-readable JSON output

Behavior:
  1. Fetch all fact IDs whose row-level verdict is 'unverifiable' from the wiki-server.
  2. Filter local FactBase: facts that have a source URL AND are in the unverifiable set.
     Skip inverse facts and verifiable:false properties (override with --include-non-verifiable).
  3. For each fact, call the source-discover engine with the *current* source URL passed
     as existingSourceUrl, so the LLM judges "is the existing URL still authoritative?"
  4. For each result with best ≠ null AND best ≠ existing AND confidence ≥ threshold,
     overwrite the YAML source URL via updateFactMetaById with overwriteExisting=true,
     annotated notes="${PROVENANCE_NOTE}".
  5. For results with no better candidate (best=null, best=existing, or engine error),
     append the fact to a manual-review file with reason + candidates.
  6. On --apply, after writes, run \`crux fb sourcing --fact=<id>\` inline on each
     replaced fact so the new verdict lands in the same run.

Acceptance (per ticket QUA-934):
  - Runs end-to-end on a 50-fact sample and lands ≥30% with new sources + improved verdicts.
  - --dry-run is the default; --apply is required to write.
  - Cost stays within --budget (soft cap; in-flight requests may overshoot slightly).
  - Manual-review output is human-readable: entity, fact, current URL, reason, candidates.
`.trim();
}
