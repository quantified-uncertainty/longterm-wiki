/**
 * HuggingFace Open LLM Leaderboard → benchmark-results importer (T1, QUA-640).
 *
 * The leaderboard publishes auto-eval results for ~5000 LLMs across the
 * BBH / GPQA / MUSR / MATH-Lvl 5 / IFEval / MMLU-Pro suite. The pipeline
 * is deterministic — same model, same eval, identical score — so we treat
 * it as T1.
 *
 * Data is published as a HuggingFace dataset:
 *   https://huggingface.co/datasets/open-llm-leaderboard/contents
 *
 * Queryable via the datasets-server API:
 *   GET https://datasets-server.huggingface.co/rows
 *     ?dataset=open-llm-leaderboard%2Fcontents
 *     &config=default&split=train
 *     &offset=<n>&length=<n>
 *
 * Each row has fields: `eval_name`, `Average ⬆️`, `IFEval`, `BBH`, `MATH Lvl 5`,
 * `GPQA`, `MUSR`, `MMLU-PRO`, model metadata, etc.
 *
 * We accept a curated list of (model_slug, eval_name) pairs from the caller —
 * the leaderboard has thousands of rows; the umbrella decides which ones
 * are wiki-worthy.
 */

import { createHash } from "crypto";
import {
  submitBatch,
  printBatchSummary,
  type ProposeClientOptions,
} from "./propose-client.ts";
import type { EnrichmentProposal } from "./types.ts";

const USER_AGENT = "longterm-wiki <ozzie@quantifieduncertainty.org>";
const DATASET = "open-llm-leaderboard/contents";

/** One leaderboard row, partial — only the fields we extract. */
export interface HfLeaderboardRow {
  /** Full eval name on the leaderboard, e.g. "meta-llama/Meta-Llama-3-70B-Instruct" */
  eval_name: string;
  /** The actual fullname is a separate field on some leaderboard versions. */
  fullname?: string;
  Average?: number;
  IFEval?: number;
  BBH?: number;
  "MATH Lvl 5"?: number;
  GPQA?: number;
  MUSR?: number;
  "MMLU-PRO"?: number;
}

/**
 * The benchmarks we map leaderboard columns to. The leaderboard column
 * is on the left; the benchmark id (matches `benchmarks.id` in PG) is
 * on the right. Source-of-truth is the umbrella seed list.
 */
export interface BenchmarkColumnMap {
  /** Column name as it appears in the leaderboard row. */
  column: keyof HfLeaderboardRow;
  /** TableBase benchmark id (10-char). */
  benchmarkId: string;
  /** Human-readable benchmark slug, used for entityRefs. */
  benchmarkSlug: string;
  /** Score unit. The leaderboard normalizes to "%". */
  unit: string;
}

export const DEFAULT_BENCHMARK_COLUMNS: readonly BenchmarkColumnMap[] = [
  { column: "IFEval", benchmarkId: "ifeval-inst", benchmarkSlug: "ifeval", unit: "%" },
  { column: "BBH", benchmarkId: "bbh", benchmarkSlug: "bbh", unit: "%" },
  { column: "MATH Lvl 5", benchmarkId: "math-lvl5", benchmarkSlug: "math-lvl-5", unit: "%" },
  { column: "GPQA", benchmarkId: "gpqa", benchmarkSlug: "gpqa", unit: "%" },
  { column: "MUSR", benchmarkId: "musr", benchmarkSlug: "musr", unit: "%" },
  { column: "MMLU-PRO", benchmarkId: "mmlu-pro", benchmarkSlug: "mmlu-pro", unit: "%" },
] as const;

export interface HfLeaderboardTarget {
  /** Wiki entity slug for this AI model (e.g., "claude-3-5-sonnet"). */
  modelSlug: string;
  /** Display name fallback. */
  modelDisplayName: string;
  /** Exact `eval_name` as it appears in the leaderboard. */
  evalName: string;
}

export interface HfLeaderboardOptions {
  /** Override fetch — used by tests. */
  fetchImpl?: typeof fetch;
  /** Override the User-Agent. */
  userAgent?: string;
  /** Override the column → benchmark mapping. */
  benchmarkColumns?: readonly BenchmarkColumnMap[];
  /** Page size for the datasets-server query (max 100). */
  pageSize?: number;
  /** Hard cap on rows scanned per call. Defaults to 1000. */
  maxRows?: number;
  /** Reference date for the snapshot, used in the benchmark-result `date` field. */
  scoredAt?: string;
}

interface RowsResponse {
  rows: Array<{ row: HfLeaderboardRow }>;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_ROWS = 1000;

function getFetch(opts: HfLeaderboardOptions): typeof fetch {
  return opts.fetchImpl ?? globalThis.fetch;
}

function getHeaders(opts: HfLeaderboardOptions): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": opts.userAgent ?? USER_AGENT,
  };
}

/** Build the datasets-server rows URL for one page. */
export function buildRowsUrl(offset: number, length: number): string {
  const params = new URLSearchParams({
    dataset: DATASET,
    config: "default",
    split: "train",
    offset: String(offset),
    length: String(length),
  });
  return `https://datasets-server.huggingface.co/rows?${params.toString()}`;
}

/**
 * Page through the leaderboard, building a map keyed by `eval_name` for
 * O(1) lookup. Stops when `maxRows` reached or when a page returns < pageSize.
 */
export async function fetchLeaderboardSnapshot(
  opts: HfLeaderboardOptions = {}
): Promise<Map<string, HfLeaderboardRow>> {
  const pageSize = Math.min(opts.pageSize ?? DEFAULT_PAGE_SIZE, 100);
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const fetchImpl = getFetch(opts);
  const headers = getHeaders(opts);
  const out = new Map<string, HfLeaderboardRow>();
  let offset = 0;

  while (out.size < maxRows) {
    const url = buildRowsUrl(offset, pageSize);
    const resp = await fetchImpl(url, { headers });
    if (!resp.ok) {
      throw new Error(`HuggingFace datasets-server HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as RowsResponse;
    if (!data.rows || data.rows.length === 0) break;
    for (const wrap of data.rows) {
      const r = wrap.row;
      if (r?.eval_name) {
        out.set(r.eval_name, r);
      }
    }
    if (data.rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

/**
 * Lookup helper. The leaderboard publishes both `eval_name` and `fullname`
 * on some snapshots; if the `eval_name` lookup misses, fall back to a
 * full scan of `fullname`.
 */
export function lookupRow(
  snapshot: ReadonlyMap<string, HfLeaderboardRow>,
  evalName: string
): HfLeaderboardRow | null {
  const direct = snapshot.get(evalName);
  if (direct) return direct;
  for (const row of snapshot.values()) {
    if (row.fullname === evalName) return row;
  }
  return null;
}

/**
 * Build proposals — one per (target, benchmark column) pair.
 * Returns the proposals AND a list of misses (target+column) for caller logging.
 */
export function buildProposals(
  targets: readonly HfLeaderboardTarget[],
  snapshot: ReadonlyMap<string, HfLeaderboardRow>,
  opts: { benchmarkColumns?: readonly BenchmarkColumnMap[]; scoredAt?: string } = {}
): { proposals: EnrichmentProposal[]; misses: Array<{ target: HfLeaderboardTarget; reason: string }> } {
  const cols = opts.benchmarkColumns ?? DEFAULT_BENCHMARK_COLUMNS;
  const proposals: EnrichmentProposal[] = [];
  const misses: Array<{ target: HfLeaderboardTarget; reason: string }> = [];
  const date = opts.scoredAt ?? new Date().toISOString().slice(0, 10);

  for (const t of targets) {
    const row = lookupRow(snapshot, t.evalName);
    if (!row) {
      misses.push({ target: t, reason: `eval_name "${t.evalName}" not in snapshot` });
      continue;
    }
    for (const col of cols) {
      const score = row[col.column];
      if (typeof score !== "number" || !Number.isFinite(score)) {
        // Don't emit a proposal for a benchmark the model didn't run.
        continue;
      }
      const canonical = JSON.stringify({
        eval_name: t.evalName,
        column: col.column,
        score,
      });
      const responseHash = createHash("sha256").update(canonical).digest("hex");
      proposals.push({
        tier: "T1",
        source: `hf-leaderboard:${t.evalName}:${col.column}`,
        sourceUrl: `https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard?row=${encodeURIComponent(t.evalName)}`,
        responseHash,
        recordType: "benchmark-result",
        record: {
          score,
          unit: col.unit,
          date,
          sourceUrl: "https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard",
          notes: `${col.column} score from HuggingFace Open LLM Leaderboard`,
        },
        entityRefs: {
          model: t.modelSlug,
          benchmark: col.benchmarkSlug,
        },
      });
    }
  }
  return { proposals, misses };
}

/** End-to-end: fetch snapshot + build proposals. */
export async function importTargets(
  targets: readonly HfLeaderboardTarget[],
  opts: HfLeaderboardOptions = {}
): Promise<{ proposals: EnrichmentProposal[]; misses: Array<{ target: HfLeaderboardTarget; reason: string }> }> {
  const snapshot = await fetchLeaderboardSnapshot(opts);
  return buildProposals(targets, snapshot, {
    benchmarkColumns: opts.benchmarkColumns,
    scoredAt: opts.scoredAt,
  });
}

/** CLI entry — `crux tb hf-leaderboard --target=slug:displayName:evalName`. */
export async function cliMain(
  args: string[]
): Promise<{ exitCode: number; output: string }> {
  const submit = args.includes("--submit");
  const targets = parseTargetsArg(args);
  if (targets.length === 0) {
    return {
      exitCode: 2,
      output:
        "No targets specified. Pass --target=modelSlug:displayName:evalName (repeatable)",
    };
  }
  console.log(`[hf-leaderboard] fetching snapshot for ${targets.length} target(s)...`);
  const { proposals, misses } = await importTargets(targets);
  console.log(`[hf-leaderboard] built ${proposals.length} proposals; ${misses.length} target(s) missed`);
  for (const m of misses.slice(0, 10)) {
    console.log(`  - ${m.target.modelSlug}: ${m.reason}`);
  }
  const clientOpts: ProposeClientOptions = { submit };
  const results = await submitBatch(proposals, clientOpts);
  printBatchSummary(results, "hf-leaderboard");
  return { exitCode: 0, output: "" };
}

/**
 * Parse `--target=modelSlug:displayName:evalName`.
 * `displayName` and `evalName` may contain forward slashes.
 */
export function parseTargetsArg(args: readonly string[]): HfLeaderboardTarget[] {
  const out: HfLeaderboardTarget[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--target=")) continue;
    const value = arg.slice("--target=".length);
    // Use the first two colons as separators — evalName may contain colons too.
    const first = value.indexOf(":");
    const second = first === -1 ? -1 : value.indexOf(":", first + 1);
    if (first === -1 || second === -1) {
      throw new Error(
        `--target must be modelSlug:displayName:evalName, got "${value}"`
      );
    }
    const modelSlug = value.slice(0, first);
    const modelDisplayName = value.slice(first + 1, second);
    const evalName = value.slice(second + 1);
    if (!modelSlug || !modelDisplayName || !evalName) {
      throw new Error(`--target has empty segment(s): "${value}"`);
    }
    out.push({ modelSlug, modelDisplayName, evalName });
  }
  return out;
}
