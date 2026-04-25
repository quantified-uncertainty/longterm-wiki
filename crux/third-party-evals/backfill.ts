/**
 * Third-party-evals backfill driver (QUA-705).
 *
 * Wraps the existing `ingest` + `extract` + sync flow into a single batch
 * pass over an evaluator's published reports. Each candidate URL goes
 * through:
 *
 *   1. `extractEvalReport()` — LLM extraction with span verification
 *   2. `resolveAiModel()`     — match every named model against entities
 *   3. `toSyncItem()`         — build the wiki-server sync payload
 *   4. `syncThirdPartyEvaluations()` (batched) — POST to /api/.../sync
 *
 * Concurrency is capped (default 4) for the extract step. Sync items are
 * batched (default 25 per request) to stay well under the 500-item limit
 * and amortize HTTP/rate-limit overhead. Errors are non-fatal — failed
 * extractions are logged and skipped, succeeded items still ship.
 */
import { generateId } from "../lib/grant-import/id.ts";
import { resolveAiModel } from "../lib/ai-model-resolver.ts";
import { syncThirdPartyEvaluations } from "../lib/wiki-server/third-party-evaluations.ts";
import {
  extractEvalReport,
  toSyncItem,
} from "./extract-eval-report.ts";
import { verifyExtractedReport } from "./span-verify.ts";
import {
  ingestUkAisi,
} from "./ingesters/uk-aisi-sitemap.ts";
import { ingestMetr } from "./ingesters/metr-rss.ts";
import { ingestApollo } from "./ingesters/apollo-research.ts";
import { ingestCaisi } from "./ingesters/caisi-blog.ts";
import type {
  IngestCandidate,
  IngestResult,
} from "./ingesters/types.ts";

export interface BackfillOptions {
  /** Evaluator key — uk-aisi | metr | apollo | caisi (us-aisi). */
  evaluator: string;
  /** stableId of the evaluator org entity (required). */
  evaluatorOrgId: string;
  /** LLM model. Default haiku (cheap; reports are short). */
  llmModel?: string;
  /** Max parallel extract calls. Default 4. */
  concurrency?: number;
  /** Items per /sync POST. Default 25 (sync schema caps at 500). */
  batchSize?: number;
  /** Skip URLs older than this date (UK AISI sitemap only). */
  since?: string;
  /** Dry run — don't POST to /sync. */
  dryRun?: boolean;
  /** Cap candidates (for smoke testing). */
  limit?: number;
  /** Per-URL progress callback. */
  onProgress?: (event: BackfillProgress) => void;
}

export type BackfillProgress =
  | { kind: "extracted"; url: string; index: number; total: number }
  | { kind: "extract-error"; url: string; error: string; index: number; total: number }
  | { kind: "synced"; count: number; batchIndex: number }
  | { kind: "sync-error"; error: string; batchIndex: number };

export interface BackfillResult {
  evaluator: string;
  candidates: number;
  extracted: number;
  extractFailures: Array<{ url: string; error: string }>;
  synced: number;
  syncFailures: Array<{ batchIndex: number; error: string }>;
  durationMs: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_BATCH_SIZE = 25;

/**
 * Map evaluator key → ingester. Mirrors the same dispatch in the CLI.
 */
async function ingestFor(
  evaluator: string,
  options: BackfillOptions,
): Promise<IngestResult> {
  const key = evaluator.trim().toLowerCase();
  if (key === "uk-aisi" || key === "ukaisi") {
    return ingestUkAisi({ sinceDate: options.since });
  }
  if (key === "us-aisi" || key === "caisi" || key === "usaisi") {
    return ingestCaisi();
  }
  if (key === "metr") return ingestMetr();
  if (key === "apollo" || key === "apollo-research") return ingestApollo();
  throw new Error(
    `Unknown evaluator '${evaluator}'. Valid: uk-aisi, us-aisi, metr, apollo`,
  );
}

/**
 * Minimal concurrency limiter — same shape used in citation-auditor.ts.
 * Avoids pulling in p-limit as a dependency.
 */
function pLimit(concurrencyLimit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  function next() {
    if (queue.length > 0 && active < concurrencyLimit) {
      active++;
      queue.shift()!();
    }
  }
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      queue.push(run);
      next();
    });
}

/**
 * Extract one candidate. Returns a sync item ready to POST, or
 * `{ url, error }` if extraction failed.
 */
async function extractOne(
  candidate: IngestCandidate,
  options: BackfillOptions,
): Promise<
  | { kind: "ok"; item: Record<string, unknown> }
  | { kind: "err"; url: string; error: string }
> {
  try {
    const extract = await extractEvalReport({
      url: candidate.url,
      evaluatorOrgId: options.evaluatorOrgId,
      llmModel: options.llmModel,
    });

    const verify = verifyExtractedReport(extract.report, extract.sourceText);

    const modelLinks = verify.verifiedReport.modelsNamed
      .map((rawName) => {
        const top = resolveAiModel(rawName, { maxResults: 1 })[0];
        if (!top) return null;
        return {
          aiModelId: top.stableId,
          aiModelDisplayName: top.title,
          rawNameInReport: rawName,
          matchConfidence: top.matchConfidence,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const id = generateId(`third-party-eval:${candidate.url}:${extract.sourceHash}`);
    const item = toSyncItem(extract, {
      id,
      evaluatorOrgId: options.evaluatorOrgId,
      reportUrl: candidate.url,
      sourceSystem: candidate.sourceSystem,
      models: modelLinks,
      confidenceMap: verify.confidenceMap,
    });

    return { kind: "ok", item };
  } catch (e) {
    return {
      kind: "err",
      url: candidate.url,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Backfill a single evaluator end-to-end. See BackfillOptions for knobs.
 */
export async function backfillEvaluator(
  options: BackfillOptions,
): Promise<BackfillResult> {
  const start = Date.now();
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const onProgress = options.onProgress ?? (() => {});

  const ingest = await ingestFor(options.evaluator, options);
  let candidates = ingest.candidates;
  if (options.limit != null && options.limit > 0) {
    candidates = candidates.slice(0, options.limit);
  }
  const total = candidates.length;

  // Extract phase — concurrent.
  const limit = pLimit(concurrency);
  const items: Array<Record<string, unknown>> = [];
  const extractFailures: Array<{ url: string; error: string }> = [];

  await Promise.all(
    candidates.map((c, idx) =>
      limit(async () => {
        const r = await extractOne(c, options);
        if (r.kind === "ok") {
          items.push(r.item);
          onProgress({ kind: "extracted", url: c.url, index: idx + 1, total });
        } else {
          extractFailures.push({ url: r.url, error: r.error });
          onProgress({
            kind: "extract-error",
            url: r.url,
            error: r.error,
            index: idx + 1,
            total,
          });
        }
      }),
    ),
  );

  // Sync phase — batched.
  let synced = 0;
  const syncFailures: Array<{ batchIndex: number; error: string }> = [];
  if (!options.dryRun) {
    for (let i = 0; i < items.length; i += batchSize) {
      const chunk = items.slice(i, i + batchSize);
      const batchIndex = Math.floor(i / batchSize);
      const r = await syncThirdPartyEvaluations(chunk);
      if (r.ok) {
        synced += chunk.length;
        onProgress({ kind: "synced", count: chunk.length, batchIndex });
      } else {
        syncFailures.push({
          batchIndex,
          error: `${r.error}: ${r.message}`,
        });
        onProgress({
          kind: "sync-error",
          error: `${r.error}: ${r.message}`,
          batchIndex,
        });
      }
    }
  }

  return {
    evaluator: ingest.evaluator,
    candidates: total,
    extracted: items.length,
    extractFailures,
    synced,
    syncFailures,
    durationMs: Date.now() - start,
  };
}
