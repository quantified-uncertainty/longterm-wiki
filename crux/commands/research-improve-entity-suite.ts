// crux tb improve-entity-suite — orchestrates the closed-loop improver across
// every entity in `crux/benchmarks/entity-suite.yaml`.
//
// QUA-882. Pairs with `crux tb benchmark-suite --diff` (QUA-873) which reads
// the YAML state delta. This command produces the *process* metrics
// (verified-rate, cost, applied counts) the read-only benchmark can't see.
//
// Usage:
//   pnpm crux tb improve-entity-suite --tag=baseline --max-iters=1
//   pnpm crux tb improve-entity-suite --tag=after-token-filter --budget=5 --dry-run

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import { z } from "zod";

import { type CommandResult } from "../lib/cli.ts";
import {
  type ImproveOptions,
  type ImproveResult,
  improveSingleEntity,
} from "./research-improve-entity.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SUITE_YAML = path.join(ROOT, "crux/benchmarks/entity-suite.yaml");
const SNAPSHOT_DIR = path.join(ROOT, ".claude/snapshots/improve-entity-suite");

// ── Suite YAML schema ───────────────────────────────────────────────────────

const SuiteEntrySchema = z.object({
  slug: z.string().min(1),
  type: z.string().min(1),
  expected_min_coverage: z.number().min(0).max(1).optional(),
});

const SuiteSchema = z.array(SuiteEntrySchema);

export type SuiteEntry = z.infer<typeof SuiteEntrySchema>;

/** Types the improve loop currently supports end-to-end. v1: policy-only. */
const SUPPORTED_TYPES = new Set<string>(["policy"]);

/** Per-entity floor below which the inner loop is guaranteed to no-op. */
export const MIN_USEFUL_BUDGET_USD = 0.05;

/**
 * Default per-entity budget allocation, USD. The CLI default total budget
 * is `DEFAULT_PER_ENTITY_BUDGET_USD * N` where N is the count of
 * supported entities in the suite YAML. QUA-1033: lowered from a flat
 * $10 total to $2 per supported entity to cap blast radius from accidental
 * suite runs (most policies converge in 1 iteration with <$2 in spend).
 */
export const DEFAULT_PER_ENTITY_BUDGET_USD = 2.0;

/**
 * Tag flows into the snapshot filename. Reject anything that could escape
 * the snapshot dir (path separators, traversal sequences) or cause shell /
 * filesystem surprises. Allowlist matches typical labels: alphanumeric,
 * dot, underscore, hyphen.
 */
const VALID_TAG_RE = /^[a-zA-Z0-9._-]+$/;
export function isValidTag(tag: string): boolean {
  return tag.length > 0 && tag.length <= 80 && VALID_TAG_RE.test(tag);
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Load + validate the suite YAML. Throws on schema violation. */
export function loadSuite(filePath: string = SUITE_YAML): SuiteEntry[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = yaml.load(raw);
  return SuiteSchema.parse(parsed);
}

/** Filter to types the improve loop currently supports. */
export function filterToSupportedTypes(entries: SuiteEntry[]): SuiteEntry[] {
  return entries.filter((e) => SUPPORTED_TYPES.has(e.type));
}

/**
 * Per-entity hard cap = 2× the equal-share expected cost.
 * Spec: "Per-entity cap: 2× expected (= total / N × 2)."
 */
export function computePerEntityCap(totalBudgetUsd: number, entityCount: number): number {
  if (entityCount <= 0) return 0;
  return (totalBudgetUsd / entityCount) * 2;
}

export interface PerEntityRecord {
  slug: string;
  type: string;
  status: "completed" | "failed" | "skipped_budget";
  /** Present on `completed` or `failed` (when failure is during a partial run). */
  result?: ImproveResult;
  /** Aggregated counts across iterations, derived from `result`. */
  iterations: ImproveResult["iterations"];
  claims_proposed: number;
  claims_verified: number;
  claims_partial: number;
  claims_contradicted: number;
  claims_unverifiable: number;
  verified_rate: number;
  applied_to_yaml: number;
  cost_usd: number;
  duration_s: number;
  error?: string;
}

export interface AggregateMetrics {
  median_verified_rate: number;
  p25_verified_rate: number;
  total_cost_usd: number;
  total_duration_s: number;
  entities_completed: number;
  entities_skipped_budget: number;
  entities_failed: number;
}

/** Aggregate iteration metrics into a per-entity row. Pure. */
export function aggregateResult(slug: string, type: string, result: ImproveResult): PerEntityRecord {
  const claims_proposed = result.iterations.reduce((s, m) => s + m.claims_proposed, 0);
  const claims_verified = result.iterations.reduce((s, m) => s + m.claims_verified, 0);
  const claims_partial = result.iterations.reduce((s, m) => s + m.claims_partial, 0);
  const claims_contradicted = result.iterations.reduce((s, m) => s + m.claims_contradicted, 0);
  const claims_unverifiable = result.iterations.reduce((s, m) => s + m.claims_unverifiable, 0);
  const applied_to_yaml = result.iterations.reduce((s, m) => s + m.applied_to_yaml, 0);
  const verified_rate =
    claims_proposed > 0 ? (claims_verified + claims_partial) / claims_proposed : 0;
  return {
    slug,
    type,
    status: "completed",
    result,
    iterations: result.iterations,
    claims_proposed,
    claims_verified,
    claims_partial,
    claims_contradicted,
    claims_unverifiable,
    verified_rate,
    applied_to_yaml,
    cost_usd: result.total_cost_usd,
    duration_s: result.total_duration_s,
  };
}

/** Median of a numeric list. Linear interpolation between adjacent samples. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  const lo = Math.floor(mid);
  const hi = Math.ceil(mid);
  return (sorted[lo] + sorted[hi]) / 2;
}

/**
 * 25th-percentile via the standard linear-interpolation method (the same
 * R-7 / NumPy default behavior). Returns 0 for empty input.
 */
export function p25(xs: number[]): number {
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0];
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * 0.25;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Compute aggregate metrics across the per-entity rows. Pure. */
export function computeAggregate(records: PerEntityRecord[]): AggregateMetrics {
  const completed = records.filter((r) => r.status === "completed");
  const verifiedRates = completed.map((r) => r.verified_rate);
  return {
    median_verified_rate: median(verifiedRates),
    p25_verified_rate: p25(verifiedRates),
    total_cost_usd: records.reduce((s, r) => s + r.cost_usd, 0),
    total_duration_s: records.reduce((s, r) => s + r.duration_s, 0),
    entities_completed: completed.length,
    entities_skipped_budget: records.filter((r) => r.status === "skipped_budget").length,
    entities_failed: records.filter((r) => r.status === "failed").length,
  };
}

// ── Suite runner ────────────────────────────────────────────────────────────

export interface SuiteRunOptions {
  tag: string;
  totalBudgetUsd: number;
  maxIters: number;
  target?: number;
  dryRun?: boolean;
  /** Path to the suite YAML. Defaults to crux/benchmarks/entity-suite.yaml. */
  suitePath?: string;
  /** Where to write the snapshot. Defaults to .claude/snapshots/improve-entity-suite/. */
  snapshotDir?: string;
  /**
   * Injected for tests — the suite runner calls this once per supported entity.
   * Default is the real `improveSingleEntity` from research-improve-entity.ts.
   */
  improver?: (opts: ImproveOptions) => Promise<ImproveResult>;
}

export interface SuiteSnapshot {
  tag: string;
  git_sha: string | null;
  started_at: string;
  ended_at: string;
  budget_usd: number;
  per_entity_cap_usd: number;
  max_iters: number;
  dry_run: boolean;
  entities: PerEntityRecord[];
  aggregate: AggregateMetrics;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Zero-row for entities that never ran (skipped_budget) or threw (failed). */
function emptyRecord(
  entry: SuiteEntry,
  status: "skipped_budget" | "failed",
  error?: string,
): PerEntityRecord {
  return {
    slug: entry.slug,
    type: entry.type,
    status,
    iterations: [],
    claims_proposed: 0,
    claims_verified: 0,
    claims_partial: 0,
    claims_contradicted: 0,
    claims_unverifiable: 0,
    verified_rate: 0,
    applied_to_yaml: 0,
    cost_usd: 0,
    duration_s: 0,
    error,
  };
}

/**
 * Run the suite. Returns the snapshot. Side effects:
 *   - Calls `improver()` once per supported entity in suite order.
 *   - Writes a snapshot file to `<snapshotDir>/<timestamp>__<tag>.json`.
 */
export async function runSuite(opts: SuiteRunOptions): Promise<SuiteSnapshot> {
  const suitePath = opts.suitePath ?? SUITE_YAML;
  const snapshotDir = opts.snapshotDir ?? SNAPSHOT_DIR;
  const improver = opts.improver ?? improveSingleEntity;

  if (!isValidTag(opts.tag)) {
    throw new Error(
      `Invalid --tag value: ${JSON.stringify(opts.tag)}. ` +
        `Tags are interpolated into the snapshot filename and must match ${VALID_TAG_RE} (≤80 chars).`,
    );
  }

  const startedAt = new Date().toISOString();
  const all = loadSuite(suitePath);
  const supported = filterToSupportedTypes(all);

  if (all.length !== supported.length) {
    const dropped = all.filter((e) => !SUPPORTED_TYPES.has(e.type));
    console.log(
      `[suite] Skipping ${dropped.length} unsupported ${dropped.length === 1 ? "entry" : "entries"}: ` +
        dropped.map((e) => `${e.slug} (${e.type})`).join(", "),
    );
  }

  const N = supported.length;
  const perEntityCap = computePerEntityCap(opts.totalBudgetUsd, N);

  const records: PerEntityRecord[] = [];
  let totalSpent = 0;

  for (const entry of supported) {
    const remaining = opts.totalBudgetUsd - totalSpent;
    if (remaining <= MIN_USEFUL_BUDGET_USD) {
      records.push(emptyRecord(entry, "skipped_budget"));
      continue;
    }
    // Per-entity soft cap: 2× the equal-share allocation. The inner loop's
    // own budget guard runs *between* iterations, so a single iteration that
    // overshoots the cap is allowed to complete — see `improveSingleEntity`.
    // The post-iter warning below catches actual cap-hits.
    const entityBudget = Math.min(perEntityCap, remaining);
    console.log(
      `\n=== [${records.length + 1}/${N}] improve-entity-suite: ${entry.slug} ` +
        `(budget=$${entityBudget.toFixed(2)}, remaining=$${remaining.toFixed(2)}) ===`,
    );
    try {
      const result = await improver({
        slug: entry.slug,
        target: opts.target,
        budgetUsd: entityBudget,
        maxIters: opts.maxIters,
        dryRun: opts.dryRun,
        quiet: true,
      });
      const record = aggregateResult(entry.slug, entry.type, result);
      records.push(record);
      totalSpent += result.total_cost_usd;
      if (result.total_cost_usd >= perEntityCap * 0.99) {
        console.warn(
          `[suite] WARNING: ${entry.slug} hit per-entity cap ($${perEntityCap.toFixed(2)}); ` +
            `inner loop may have been truncated.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[suite] FAILED: ${entry.slug}: ${msg}`);
      records.push(emptyRecord(entry, "failed", msg));
    }
  }

  const aggregate = computeAggregate(records);
  const endedAt = new Date().toISOString();
  const snapshot: SuiteSnapshot = {
    tag: opts.tag,
    git_sha: gitSha(),
    started_at: startedAt,
    ended_at: endedAt,
    budget_usd: opts.totalBudgetUsd,
    per_entity_cap_usd: perEntityCap,
    max_iters: opts.maxIters,
    dry_run: !!opts.dryRun,
    entities: records,
    aggregate,
  };

  fs.mkdirSync(snapshotDir, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const fileName = `${stamp}__${opts.tag}.json`;
  fs.writeFileSync(path.join(snapshotDir, fileName), JSON.stringify(snapshot, null, 2) + "\n");

  return snapshot;
}

// ── CLI entry point ─────────────────────────────────────────────────────────

export async function run(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  void args;
  const tag = String(options.tag ?? "").trim();
  if (!tag) {
    return {
      output:
        "Usage: crux tb improve-entity-suite --tag=<label> [--budget=$N] [--max-iters=N] [--target=N] [--dry-run]",
      exitCode: 1,
    };
  }
  if (!isValidTag(tag)) {
    return {
      output:
        `--tag must match ${VALID_TAG_RE} (≤80 chars). It is interpolated into the snapshot filename.`,
      exitCode: 1,
    };
  }
  // QUA-1033: default is $2 × N supported entities (computed at runtime), not
  // a flat $10. We load the suite once here to count supported entities so the
  // default scales with suite size; the explicit `--budget` flag still wins.
  let totalBudgetUsd: number;
  if (options.budget != null) {
    totalBudgetUsd = parseFloat(options.budget as string);
  } else {
    let supportedCount: number;
    try {
      supportedCount = filterToSupportedTypes(loadSuite()).length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Failed to load suite for default budget: ${msg}`, exitCode: 1 };
    }
    totalBudgetUsd = DEFAULT_PER_ENTITY_BUDGET_USD * supportedCount;
  }
  const maxIters = options.maxIters != null ? parseInt(options.maxIters as string, 10) : 1;
  const target = options.target != null ? parseInt(options.target as string, 10) : undefined;
  const dryRun = !!options.dryRun;

  if (!Number.isFinite(totalBudgetUsd) || totalBudgetUsd <= 0) {
    return { output: `--budget must be a positive number; got ${options.budget}`, exitCode: 1 };
  }
  if (!Number.isFinite(maxIters) || maxIters <= 0) {
    return { output: `--max-iters must be a positive integer; got ${options.maxIters}`, exitCode: 1 };
  }
  if (target != null && (!Number.isFinite(target) || target <= 0)) {
    return { output: `--target must be a positive integer; got ${options.target}`, exitCode: 1 };
  }

  let snapshot;
  try {
    snapshot = await runSuite({ tag, totalBudgetUsd, maxIters, target, dryRun });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `improve-entity-suite failed: ${msg}`, exitCode: 1 };
  }

  console.log("\n=== improve-entity-suite result ===");
  console.log(`tag:                       ${snapshot.tag}`);
  console.log(`git_sha:                   ${snapshot.git_sha ?? "(unknown)"}`);
  console.log(`entities_completed:        ${snapshot.aggregate.entities_completed}`);
  console.log(`entities_skipped_budget:   ${snapshot.aggregate.entities_skipped_budget}`);
  console.log(`entities_failed:           ${snapshot.aggregate.entities_failed}`);
  console.log(`median_verified_rate:      ${snapshot.aggregate.median_verified_rate.toFixed(3)}`);
  console.log(`p25_verified_rate:         ${snapshot.aggregate.p25_verified_rate.toFixed(3)}`);
  console.log(`total_cost_usd:            $${snapshot.aggregate.total_cost_usd.toFixed(2)}`);
  console.log(`total_duration_s:          ${snapshot.aggregate.total_duration_s.toFixed(1)}`);
  for (const r of snapshot.entities) {
    if (r.status === "completed") {
      console.log(
        `  [${r.status}] ${r.slug.padEnd(28)} verified=${r.verified_rate.toFixed(2)} ` +
          `applied=${r.applied_to_yaml} cost=$${r.cost_usd.toFixed(3)}`,
      );
    } else {
      console.log(`  [${r.status}] ${r.slug.padEnd(28)} ${r.error ?? ""}`);
    }
  }

  // Exit code: 0 if any entity completed; 2 if all skipped/failed.
  const exitCode = snapshot.aggregate.entities_completed > 0 ? 0 : 2;
  return { output: "", exitCode };
}

export function help(): CommandResult {
  return {
    output: `crux tb improve-entity-suite --tag=<label> [--budget=$N] [--max-iters=N] [--target=N] [--dry-run]

Run the closed-loop improve-entity over every supported entity in
crux/benchmarks/entity-suite.yaml. Produces a structured snapshot under
.claude/snapshots/improve-entity-suite/<timestamp>__<tag>.json with
per-entity verified-rate / cost / applied counts plus aggregate metrics.

Pair with \`crux tb benchmark-suite --diff=<a>,<b>\` (QUA-873) for the YAML
state delta.

Options:
  --tag=<label>     Required. Snapshot label (e.g. baseline, after-X).
  --budget=N        Total LLM spend cap across the suite, USD.
                    Default: $${DEFAULT_PER_ENTITY_BUDGET_USD.toFixed(0)} × N supported entities (QUA-1033).
  --max-iters=N     Max iterations per entity (default 1).
  --target=N        Per-entity (provisions+stakeholders) target (passed through).
  --dry-run         Don't write YAML changes back to data/entities/responses.yaml.

Budget governance:
  Per-entity soft cap = 2 × (total_budget / N) where N = supported entities.
  This is a soft cap: a single iteration may overshoot it, since runResearch
  spends until its own budgetCap. The suite halts mid-run when remaining
  budget falls below $${MIN_USEFUL_BUDGET_USD.toFixed(2)}; remaining entities
  are recorded as \`skipped_budget\`. \`--budget\` is therefore a target, not
  a strict bound.
`,
    exitCode: 0,
  };
}

export const commands = { default: run, help };
export const getHelp = () => help().output;
