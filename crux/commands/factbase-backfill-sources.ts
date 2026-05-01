/**
 * FactBase Backfill-Sources Wrapper — QUA-933
 *
 * Wraps the QUA-926 source-discover engine in a NULL-source backfill loop
 * that lands sources + verdicts on FactBase facts that lack `source:` URLs
 * (~511 such facts at filing time).
 *
 * Pipeline (per fact):
 *   1. Filter: facts where !fact.source. Optional `--property=<id>` filter
 *      narrows to one property. Inverse facts and `verifiable:false`
 *      properties (e.g. `website`, `wikipedia-url`) are skipped.
 *   2. Discover: call `discoverSourceForFact()` (real-time) or build an
 *      Anthropic Batch API request via `buildDiscoveryBatchRequest()`
 *      (`--batch`, 50% cheaper, async polling).
 *   3. Apply: when `result.best !== null` AND confidence ≥ threshold, write
 *      the URL back to YAML via `updateFactMetaById()`. Annotate with
 *      `notes: "[auto-discovered by qua-926]"`. NEVER overwrites an existing
 *      `source` (the writer no-ops in that case).
 *   4. Verify chain: after a successful YAML write, reload the graph and run
 *      the existing fact-sourcing pipeline (factbase-sourcing.ts) inline on
 *      the freshly-sourced facts so verdicts land in the same run.
 *
 * Command:
 *   crux fb backfill-sources --property=<id> --where-no-source --budget=N \
 *                            [--batch] [--dry-run] [--apply] [--no-verify-chain]
 *
 * Defaults: --dry-run; require explicit --apply to write.
 *
 * The wrapper is intentionally thin: budgeting, YAML writing, and verify
 * chaining live here; LLM prompting and parsing live in the engine
 * (`crux/lib/sourcing/source-discover.ts`).
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { formatFactValue } from '../../packages/factbase/src/format.ts';
import type { Entity, Fact, Property } from '../../packages/factbase/src/types.ts';
import { loadGraphFull, KB_DATA_DIR } from '../lib/factbase-loader.ts';
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
} from '../lib/sourcing/source-discover.ts';
import {
  submitBatch,
  pollBatch,
  getBatchResults,
  type MessageBatch,
} from '../lib/anthropic-batch.ts';
import { createLlmClient } from '../lib/llm.ts';
import { collectUnsourcedFacts } from './factbase-source-backfill.ts';
import { sourcingCommand } from './factbase-sourcing.ts';

// ── Constants ────────────────────────────────────────────────────────

/** Default soft cap on USD spend per run. The engine is web_search-heavy so
 * cost per fact is meaningfully higher than fact-verify; default budget
 * keeps a default-flag run from accidentally processing the entire backlog. */
const DEFAULT_BUDGET_USD = 5.0;

/** Default cap on facts processed in one run (independent of budget). */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 2000;

/** Real-time concurrency for non-batch mode. The engine uses web_search so
 * we keep this conservative — Anthropic rate-limits server tools per minute. */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

/** Estimated USD cost per discover call. Sonnet + ≤3 web searches lands here
 * empirically (matches the QUA-933 description's $0.02 batch / $0.04 real-time
 * rule of thumb). Used for budget gating BEFORE the call so we don't overshoot. */
const ESTIMATED_REALTIME_COST_USD = 0.04;
const ESTIMATED_BATCH_COST_USD = 0.02;

/** Provenance string written to the fact's `notes:` field on auto-discovery. */
const PROVENANCE_NOTE = '[auto-discovered by qua-926]';

/** Polling cadence for --batch mode. Anthropic batches typically complete in
 * minutes for small-to-medium sizes; poll every 30s and bail after 1h. */
const BATCH_POLL_INTERVAL_MS = 30_000;
const BATCH_POLL_TIMEOUT_MS = 60 * 60 * 1_000;

// ── Types ────────────────────────────────────────────────────────────

export interface BackfillSourcesOptions extends BaseOptions {
  property?: string;
  entity?: string;
  /** Default behavior: filter for facts where !fact.source. The flag is
   * accepted explicitly per the command spec; absence does not change
   * behavior — this command only ever processes unsourced facts. */
  'where-no-source'?: boolean;
  whereNoSource?: boolean;
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
  'include-editorial'?: boolean;
  includeEditorial?: boolean;
  'include-non-verifiable'?: boolean;
  includeNonVerifiable?: boolean;
  ci?: boolean;
  json?: boolean;
}

interface FactDiscovery {
  entity: Entity;
  fact: Fact;
  propertyName: string;
  formattedValue: string;
  result: DiscoverResult | null;
  error?: string;
}

type WriteOutcome =
  | { kind: 'wrote'; url: string }
  | { kind: 'skipped-existing' }
  | { kind: 'not-found' }
  | { kind: 'no-best' }
  | { kind: 'error'; error: string };

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

interface BackfillSummary {
  scanned: number;
  discovered: number;
  noBest: number;
  engineErrors: number;
  /**
   * Batch-mode only: count of customIds Anthropic returned that we never
   * submitted (provider-side bug or response corruption). Counted separately
   * from `engineErrors` because the work was never even our request, so
   * conflating it with our own failure rate would mislead operators.
   */
  unknownCustomIds: number;
  /**
   * Batch-mode only: count of facts we submitted whose customId did not
   * appear in the response set. The work was lost — Anthropic accepted the
   * request but never produced a response for it. Folded into `engineErrors`
   * via the response-loop reconciliation pass; tracked here so operators
   * can distinguish "never returned" from "returned with errored type".
   */
  missingResponses: number;
  writesAttempted: number;
  writesSucceeded: number;
  writesSkippedExisting: number;
  writesNotFound: number;
  writeErrors: number;
  verifyAttempted: number;
  verifySucceeded: number;
  verifyFailed: number;
  costUsd: number;
  budgetExhausted: boolean;
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

function zeroSummary(): BackfillSummary {
  return {
    scanned: 0,
    discovered: 0,
    noBest: 0,
    engineErrors: 0,
    unknownCustomIds: 0,
    missingResponses: 0,
    writesAttempted: 0,
    writesSucceeded: 0,
    writesSkippedExisting: 0,
    writesNotFound: 0,
    writeErrors: 0,
    verifyAttempted: 0,
    verifySucceeded: 0,
    verifyFailed: 0,
    costUsd: 0,
    budgetExhausted: false,
  };
}

/**
 * Build the engine input shape from a (kb, entity, fact) tuple. Pure helper
 * exposed for tests so they can construct inputs without re-loading the KB.
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
 * factbase-source-backfill.ts so we don't grow a third copy in lib/.
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

// ── Discovery: real-time path ────────────────────────────────────────

async function discoverRealtime(
  kb: LoadedKB,
  facts: Array<{ entity: Entity; fact: Fact }>,
  options: { threshold: number; budget: number; concurrency: number; log: (m: string) => void },
  summary: BackfillSummary,
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
    try {
      const result = await discoverSourceForFact(
        {
          entity,
          fact,
          property: input.property,
          formattedValue: input.formattedValue,
        },
        { threshold: options.threshold },
      );
      summary.costUsd += result.costUsd;
      results.push({
        entity,
        fact,
        propertyName: input.propertyName,
        formattedValue: input.formattedValue,
        result,
      });
      if (result.best) summary.discovered++;
      else summary.noBest++;
    } catch (e) {
      summary.engineErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        entity,
        fact,
        propertyName: input.propertyName,
        formattedValue: input.formattedValue,
        result: null,
        error: msg,
      });
    }
  });

  await runWithConcurrency(options.concurrency, tasks);
  return results;
}

// ── Discovery: batch path ────────────────────────────────────────────

async function discoverBatch(
  kb: LoadedKB,
  facts: Array<{ entity: Entity; fact: Fact }>,
  options: { threshold: number; budget: number; log: (m: string) => void },
  summary: BackfillSummary,
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

  if (inBudget.length === 0) {
    return [];
  }

  // Build requests + customId↔fact lookup in a single pass so we don't
  // re-resolve property + format the value twice per fact.
  const customIdToFact = new Map<string, { entity: Entity; fact: Fact; propertyName: string; formattedValue: string }>();
  const requests = inBudget.map(({ entity, fact }) => {
    const input = makeDiscoverInput(kb, entity, fact);
    const req = buildDiscoveryBatchRequest(
      {
        entity,
        fact,
        property: input.property,
        formattedValue: input.formattedValue,
      },
      { threshold: options.threshold },
    );
    customIdToFact.set(req.customId, {
      entity,
      fact,
      propertyName: input.propertyName,
      formattedValue: input.formattedValue,
    });
    return req;
  });

  options.log(`Submitting batch of ${requests.length} discovery request(s) to Anthropic Batch API…`);
  const client = createLlmClient();
  const submitted: MessageBatch = await submitBatch(client, requests);
  options.log(`Batch ${submitted.id} submitted; polling every ${BATCH_POLL_INTERVAL_MS / 1000}s (timeout ${BATCH_POLL_TIMEOUT_MS / 60000} min)…`);

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

  // Charge the cost estimate up-front based on submission count, not on
  // successful responses. Anthropic bills for every request that processed
  // (including errored ones), and for our budget-tracking purposes a fact
  // we lost (provider dropped the response) still consumed quota. Charging
  // only on the success branch under-reported cost — operators saw
  // `costUsd: $0.98` after a 50-fact run with 1 drop while actual billing
  // was ~$1.00. Charging once up-front matches submission semantics and
  // makes the budget-gate math (which is also estimate-based) consistent
  // across runs.
  summary.costUsd += requests.length * ESTIMATED_BATCH_COST_USD;

  // Track which submitted customIds we saw a response for so we can detect
  // facts Anthropic accepted but never returned a result for. Pre-fix, those
  // facts would silently disappear from `summary.scanned` — operators couldn't
  // reconcile "facts to process: N" against "scanned: M < N" and would have
  // no error trail. Post-fix, every missing response is counted as an
  // engineError with a synthetic FactDiscovery so the report can name it.
  const seenCustomIds = new Set<string>();

  for (const [customId, response] of responses) {
    const ctx = customIdToFact.get(customId);
    if (!ctx) {
      // Unknown customId — Anthropic returned a result we didn't submit.
      // Provider-side bug or response-set corruption. Counted separately
      // from `engineErrors` so operators can distinguish "we lost work" from
      // "they sent us garbage." Skip with a warning rather than crashing.
      summary.unknownCustomIds++;
      options.log(`  [warn] batch returned unknown customId: ${customId} (provider drift; not in our submission set)`);
      continue;
    }
    seenCustomIds.add(customId);
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
        result: null,
        error: `batch ${response.result.type}: ${errMsg}`,
      });
      continue;
    }

    const text = extractTextFromMessage(response.result.message);
    const parsed = parseDiscoveryResponse(text, options.threshold);
    // No per-response cost increment — already charged up-front. The engine
    // returns costUsd: 0 for the batch path (per source-discover.ts contract).
    const discoverResult: DiscoverResult = { ...parsed, costUsd: 0 };
    results.push({
      entity: ctx.entity,
      fact: ctx.fact,
      propertyName: ctx.propertyName,
      formattedValue: ctx.formattedValue,
      result: discoverResult,
    });
    if (discoverResult.best) summary.discovered++;
    else summary.noBest++;
  }

  // Reconciliation pass: emit synthetic engine-error entries for any
  // customId we submitted but never saw in the response set. Without this,
  // the work is silently dropped — `summary.scanned < submitted.length`
  // with no error trail, and the per-fact report skips them entirely.
  for (const [customId, ctx] of customIdToFact) {
    if (seenCustomIds.has(customId)) continue;
    summary.scanned++;
    summary.engineErrors++;
    summary.missingResponses++;
    options.log(`  [warn] batch did not return a response for customId ${customId} (fact ${ctx.fact.id})`);
    results.push({
      entity: ctx.entity,
      fact: ctx.fact,
      propertyName: ctx.propertyName,
      formattedValue: ctx.formattedValue,
      result: null,
      error: `batch did not return a response for this customId (provider drop)`,
    });
  }

  if (summary.missingResponses > 0 || summary.unknownCustomIds > 0) {
    options.log(
      `  [reconcile] submitted ${requests.length} request(s), got ${responses.size} response(s): ${summary.missingResponses} dropped, ${summary.unknownCustomIds} unknown customId(s) returned`,
    );
  }

  return results;
}

// ── Apply: write to YAML ─────────────────────────────────────────────

/**
 * Group successful discoveries by entity, then read+write each entity's YAML
 * exactly once. Mirrors the strategy in factbase-source-backfill.ts.
 */
function applyToYaml(
  discoveries: FactDiscovery[],
  kb: LoadedKB,
  log: (m: string) => void,
  summary: BackfillSummary,
): FactWriteResult[] {
  const writes: FactWriteResult[] = [];
  const byEntity = new Map<string, Array<{ factId: string; url: string }>>();

  for (const d of discoveries) {
    if (!d.result || !d.result.best) {
      writes.push({
        factId: d.fact.id,
        entityId: d.entity.id,
        outcome: d.error
          ? { kind: 'error', error: d.error }
          : { kind: 'no-best' },
      });
      continue;
    }
    const list = byEntity.get(d.entity.id);
    const next = { factId: d.fact.id, url: d.result.best };
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
          outcome: { kind: 'error', error: `no filename for entity ${entityId}` },
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
          outcome: { kind: 'error', error: `YAML file not found for ${slug}` },
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
          outcome: { kind: 'error', error: `read failed: ${msg}` },
        });
      }
      continue;
    }

    // Capture the index where THIS entity's writes start so the
    // write-failure re-classification below can scan exactly this entity's
    // outcomes (regardless of the mix of wrote / skipped / not-found).
    // `writes.length - changed` would mis-handle the case where some
    // updates landed as wrote and others as skipped/not-found in the same
    // entity loop — the last N entries would not all be wrote.
    const entityWritesStartIdx = writes.length;
    let changed = 0;
    for (const { factId, url } of updates) {
      const status = updateFactMetaById(doc, factId, {
        source: url,
        notes: PROVENANCE_NOTE,
      });
      if (status === 'updated') {
        changed++;
        summary.writesSucceeded++;
        writes.push({ factId, entityId, outcome: { kind: 'wrote', url } });
      } else if (status === 'skipped-existing') {
        summary.writesSkippedExisting++;
        writes.push({ factId, entityId, outcome: { kind: 'skipped-existing' } });
      } else {
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
        // Re-classify every `wrote` outcome added during this entity's loop
        // as an error. Other outcomes (skipped, not-found) are accurate
        // regardless of the physical write.
        for (let i = entityWritesStartIdx; i < writes.length; i++) {
          if (writes[i].outcome.kind === 'wrote') {
            summary.writesSucceeded--;
            summary.writeErrors++;
            writes[i] = {
              ...writes[i],
              outcome: { kind: 'error', error: `write failed: ${msg}` },
            };
          }
        }
      }
    }
  }

  return writes;
}

// ── Verify chain ─────────────────────────────────────────────────────

/**
 * Patterns sourcingCommand uses to signal "nothing to do" via exit code 0.
 * These are NOT verify successes — they indicate the post-write reload
 * couldn't find the fact (race, slug rename, atomic-rename lag, fact-id
 * collision) or the fact lacks a source URL the verifier can fetch. The
 * wrapper must NOT count these as verdicts landed.
 *
 * See `crux/commands/factbase-sourcing.ts` (sourcingCommand: "if
 * factsToVerify.length === 0" branch) for the canonical message strings.
 * The patterns here are anchored to the start-of-output to avoid matching
 * legitimate verify output that happens to embed the substring.
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

/**
 * After --apply writes succeed, run the existing fact-sourcing pipeline
 * inline on the freshly-sourced facts. Calls `sourcingCommand({ fact: id })`
 * once per fact ID (the command reloads the KB on each call, so writes are
 * visible). The output from each call is returned to the caller's stdout so
 * the wrapper run feels like one continuous operation.
 *
 * Skipped (no-op) when:
 *   - --no-verify-chain is set
 *   - no facts were actually written (nothing to verify)
 *
 * The verify chain runs sequentially rather than concurrently — each call
 * fetches source content + calls the LLM + stores a verdict. Concurrency
 * here would race against per-fact storage and the wiki-server's verdict
 * upsert; sequential is simpler and matches how `crux fb sourcing` runs.
 *
 * QUA-963 CRITICAL fix: `sourcingCommand` returns exit code 0 with output
 * `"Fact not found or has no source URL: <id>"` when the post-write reload
 * doesn't see the fact (race, fact-id collision, slug rename, etc.). Without
 * the no-op detection below, the wrapper would silently count those as
 * `succeeded` while zero verdicts actually landed — operators would see
 * "Verify succeeded: N" and trust it. Match the no-op patterns and re-classify
 * as `failed` so the count reflects actual verdict landings.
 */
async function runVerifyChain(
  factIds: string[],
  log: (m: string) => void,
): Promise<VerifySummary> {
  const summary: VerifySummary = { attempted: 0, succeeded: 0, failed: 0 };
  if (factIds.length === 0) return summary;

  log(`Running verify chain on ${factIds.length} freshly-sourced fact(s)…`);
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

async function backfillSourcesCommand(
  _args: string[],
  options: BackfillSourcesOptions,
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
  const includeEditorial = Boolean(
    options['include-editorial'] ?? options.includeEditorial,
  );
  const includeNonVerifiable = Boolean(
    options['include-non-verifiable'] ?? options.includeNonVerifiable,
  );
  const propertyFilter = options.property?.trim() || undefined;
  const entityFilter = options.entity?.trim() || undefined;
  const isJson = Boolean(options.ci || options.json);

  const log = (msg: string) => { if (!isJson) console.log(msg); };

  const kb = await loadGraphFull();

  const facts = collectUnsourcedFacts(kb, {
    entity: entityFilter,
    property: propertyFilter,
    includeEditorial,
    includeNonVerifiable,
    limit,
  });

  log(`FactBase backfill-sources (QUA-933 — wraps QUA-926 engine)`);
  log(`  mode:           ${apply ? 'APPLY' : 'dry-run'}`);
  log(`  pipeline:       ${useBatch ? 'Anthropic Batch API (50% off)' : 'real-time LLM'}`);
  log(`  limit:          ${limit}`);
  log(`  budget:         $${budget.toFixed(2)}`);
  log(`  threshold:      ${threshold.toFixed(2)}`);
  if (!useBatch) log(`  concurrency:    ${concurrency}`);
  if (propertyFilter) log(`  property:       ${propertyFilter}`);
  if (entityFilter) log(`  entity:         ${entityFilter}`);
  if (includeEditorial) log(`  include-editorial: yes`);
  if (includeNonVerifiable) log(`  include-non-verifiable: yes`);
  log(`  facts to process: ${facts.length}`);
  log('');

  if (facts.length === 0) {
    const empty = isJson
      ? JSON.stringify({ summary: { ...zeroSummary(), apply, batch: useBatch }, results: [] })
      : 'No unsourced facts match the given filters.';
    return { exitCode: 0, output: empty };
  }

  const summary = zeroSummary();

  // ── Discover ──────────────────────────────────────────────────────
  const discoveries = useBatch
    ? await discoverBatch(kb, facts, { threshold, budget, log }, summary)
    : await discoverRealtime(kb, facts, { threshold, budget, concurrency, log }, summary);

  // ── Apply ─────────────────────────────────────────────────────────
  let writes: FactWriteResult[] = [];
  if (apply) {
    writes = applyToYaml(discoveries, kb, log, summary);
  }

  // ── Verify chain ──────────────────────────────────────────────────
  let verify: VerifySummary = { attempted: 0, succeeded: 0, failed: 0 };
  if (apply && !skipVerifyChain) {
    const writtenFactIds = writes
      .filter((w) => w.outcome.kind === 'wrote')
      .map((w) => w.factId);
    verify = await runVerifyChain(writtenFactIds, log);
    summary.verifyAttempted = verify.attempted;
    summary.verifySucceeded = verify.succeeded;
    summary.verifyFailed = verify.failed;
  }

  // ── Output ────────────────────────────────────────────────────────
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
          best: d.result?.best ?? null,
          candidateCount: d.result?.candidates.length ?? 0,
          reason: d.result?.reason ?? d.error ?? '',
          error: d.error ?? null,
        })),
        writes: writes.map((w) => ({
          factId: w.factId,
          entityId: w.entityId,
          outcome: w.outcome.kind,
          ...(w.outcome.kind === 'wrote' && { url: w.outcome.url }),
          ...(w.outcome.kind === 'error' && { error: w.outcome.error }),
        })),
      }),
    };
  }

  return { exitCode: 0, output: formatReport(discoveries, writes, summary, apply, dryRun) };
}

function formatReport(
  discoveries: FactDiscovery[],
  writes: FactWriteResult[],
  summary: BackfillSummary,
  apply: boolean,
  dryRun: boolean,
): string {
  const lines: string[] = [];

  // Group discoveries by entity for readability.
  const byEntity = new Map<string, FactDiscovery[]>();
  for (const d of discoveries) {
    const existing = byEntity.get(d.entity.id);
    if (existing) existing.push(d);
    else byEntity.set(d.entity.id, [d]);
  }

  for (const [, entries] of byEntity) {
    const entity = entries[0].entity;
    lines.push(`\x1b[1m${entity.name}\x1b[0m (${entity.id}) — ${entries.length} unsourced fact(s)`);
    for (const d of entries) {
      const asOf = d.fact.asOf ? ` [${d.fact.asOf}]` : '';
      lines.push(`  ${d.propertyName}: ${d.formattedValue}${asOf}  (${d.fact.id})`);
      if (d.error) {
        lines.push(`    \x1b[31m✗ engine error: ${d.error}\x1b[0m`);
      } else if (!d.result || d.result.candidates.length === 0) {
        lines.push(`    \x1b[33m(no candidates discovered)\x1b[0m`);
      } else {
        for (const c of d.result.candidates) {
          const marker = c.url === d.result.best ? '\x1b[32m★\x1b[0m' : ' ';
          lines.push(`    ${marker} [${c.confidence.toFixed(2)}] ${c.url}`);
        }
        if (!d.result.best) {
          lines.push(`    \x1b[33m(no candidate met threshold; reason: ${d.result.reason})\x1b[0m`);
        }
      }
    }
    lines.push('');
  }

  lines.push('=== Summary ===');
  lines.push(`Scanned:               ${summary.scanned}`);
  lines.push(`Discovered (best):     ${summary.discovered}`);
  lines.push(`No best candidate:     ${summary.noBest}`);
  lines.push(`Engine errors:         ${summary.engineErrors}`);
  // Batch-mode reconciliation counters. Hidden when zero to keep real-time
  // mode's report uncluttered (those fields are always 0 in real-time).
  if (summary.missingResponses > 0) {
    lines.push(`  Missing responses:   ${summary.missingResponses} (provider dropped — included in engine errors)`);
  }
  if (summary.unknownCustomIds > 0) {
    lines.push(`  Unknown customIds:   ${summary.unknownCustomIds} (provider returned customIds we didn't submit)`);
  }
  if (apply) {
    lines.push(`Writes attempted:      ${summary.writesAttempted}`);
    lines.push(`Writes succeeded:      ${summary.writesSucceeded}`);
    lines.push(`Skipped (had source):  ${summary.writesSkippedExisting}`);
    lines.push(`Not found in YAML:     ${summary.writesNotFound}`);
    lines.push(`Write errors:          ${summary.writeErrors}`);
    lines.push(`Verify attempted:      ${summary.verifyAttempted}`);
    lines.push(`Verify succeeded:      ${summary.verifySucceeded}`);
    lines.push(`Verify failed:         ${summary.verifyFailed}`);
  }
  lines.push(`Cost (est.):           $${summary.costUsd.toFixed(4)}`);
  lines.push(`Budget exhausted:      ${summary.budgetExhausted ? 'yes' : 'no'}`);
  lines.push('');

  if (dryRun) {
    lines.push('\x1b[2mRun with --apply to write discovered URLs to YAML and chain into verify-orchestrate.\x1b[0m');
  } else if (writes.length > 0 && summary.writesSucceeded === 0) {
    lines.push('\x1b[33mNo URLs written (all discoveries either had no `best` or were skipped/errored).\x1b[0m');
  }
  return lines.join('\n');
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: backfillSourcesCommand,
};

export function getHelp(): string {
  return `
FactBase Backfill-Sources (QUA-933) — wraps the QUA-926 source-discover engine
to fill in source URLs for facts that lack them, then chains into verify.

Usage:
  crux fb backfill-sources [options]

Options:
  --property=<id>            Filter to one property (e.g. born-year, education)
  --entity=<slug|stableId>   Filter to one entity
  --where-no-source          (no-op marker) Default behavior — only unsourced facts are scanned
  --limit=N                  Cap on facts processed (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})
  --budget=N                 Soft cap in USD on engine spend (default: $${DEFAULT_BUDGET_USD.toFixed(2)})
  --threshold=N              Confidence floor for "best" pick (0-1, default: ${DEFAULT_CONFIDENCE_THRESHOLD})
  --concurrency=N            Real-time concurrency (default: ${DEFAULT_CONCURRENCY}, max: ${MAX_CONCURRENCY}). Ignored with --batch.
  --batch                    Use Anthropic Batch API (50% cheaper, async; bounded poll up to 1h)
  --apply                    Write discovered URLs to YAML and chain into verify (default: dry-run)
  --no-verify-chain          Skip the inline verify-chain after writes (apply mode only)
  --include-editorial        Scan editorial properties (description, notable-for) — usually skipped
  --include-non-verifiable   Scan properties with verifiable:false (website, etc.)
  --json / --ci              Machine-readable JSON output

Behavior:
  1. Filter facts where !fact.source. Skip inverse facts and verifiable:false properties by default.
  2. For each fact, call the source-discover engine. With --batch, build all
     requests, submit one batch, poll until complete, then parse responses.
  3. For each result with best ≠ null AND confidence ≥ threshold, write the URL
     to YAML via updateFactMetaById (annotated notes="${PROVENANCE_NOTE}"). Never overwrites an existing source.
  4. With --apply, after writes, runs \`crux fb sourcing --fact=<id>\` inline
     on each freshly-sourced fact so verdicts land in the same run. Skip with --no-verify-chain.

Acceptance (per ticket):
  - Runs end-to-end on a high-confidence subset (e.g. born-year + education + google-scholar)
    and lands ≥80% with verdicts.
  - --dry-run is the default; --apply is required to write.
  - Cost stays within --budget (soft cap; in-flight requests may overshoot slightly).
`.trim();
}
