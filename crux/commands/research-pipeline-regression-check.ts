// crux tb pipeline-regression-check — QUA-871 CI gate.
//
// Compares two pairs of suite snapshots (a "baseline" pair from main-latest
// and a "candidate" pair from a PR) and decides whether the improve-entity
// pipeline regressed beyond the configured thresholds. Designed to be the
// single decision point inside the `.github/workflows/improve-pipeline-
// benchmark.yml` PR gate so the regression logic is testable in isolation
// from CI YAML.
//
// Inputs (all paths absolute or relative to CWD):
//   --baseline-coverage=<path>   benchmark-suite snapshot for main-latest
//   --candidate-coverage=<path>  benchmark-suite snapshot for the PR
//   --baseline-improve=<path>    improve-entity-suite snapshot for main-latest
//   --candidate-improve=<path>   improve-entity-suite snapshot for the PR
//   --pr-body-file=<path>        PR description text (override marker source)
//   --write-comment-file=<path>  write the markdown PR comment body here
//   --coverage-threshold=N       max allowed median(coverage_score) drop (default 0.05)
//   --verified-threshold=N       max allowed median(verified_rate) drop, 0..1 (default 0.05)
//
// Exit codes:
//   0 — pass, override, or baseline missing (advisory mode)
//   1 — fail (regression beyond thresholds, no override)
//   2 — usage error (missing/invalid candidate snapshots)

import fs from "node:fs";
import path from "node:path";

import { type CommandResult } from "../lib/cli.ts";
import type { SuiteSnapshot as CoverageSnapshot } from "./research-benchmark-suite.ts";
import type { SuiteSnapshot as ImproveSnapshot } from "./research-improve-entity-suite.ts";

/** Parsed `<!-- benchmark-skip: <reason> -->` marker from a PR body.
 *  The reason is preserved verbatim so a human can audit the override
 *  without looking at the raw body. */
export interface BenchmarkSkip {
  reason: string;
}

/**
 * Extract the override marker. Pattern is intentionally narrow — a single
 * HTML comment on a single line, with `benchmark-skip:` and a non-empty
 * reason. Multi-line / split-across-lines markers don't match (you can't
 * smuggle an override into a wall of "## Summary" prose). An empty reason
 * falls through as "no override" — a reviewer who finds an empty marker
 * should fix it rather than us silently honoring it.
 */
export function parseBenchmarkSkip(prBody: string): BenchmarkSkip | null {
  // [ \t] (not \s) on either side of the keyword so we never bridge a newline.
  const m = prBody.match(/<!--[ \t]*benchmark-skip:[ \t]*([^\n>]+?)[ \t]*-->/i);
  if (!m) return null;
  const reason = m[1].trim();
  if (!reason) return null;
  return { reason };
}

export type Verdict = "pass" | "fail" | "override" | "advisory";

export interface RegressionDecision {
  verdict: Verdict;
  /** Human-readable summary line shown at the top of the PR comment. */
  summary: string;
  /** Filled even on `override` so reviewers see what was overridden. */
  reasons: string[];
  delta: {
    median_coverage_score: number | null;
    median_verified_rate: number | null;
  };
  thresholds: {
    coverage: number;
    verified: number;
  };
  override: BenchmarkSkip | null;
}

/**
 * Pure decision logic, separated from I/O. Tested directly.
 *
 * Threshold semantics: a regression fires when the candidate metric is
 * lower than baseline by *more than* the threshold. Equality at the
 * threshold (drop == 0.05) is allowed — this is intentional jitter
 * tolerance, since suite-level medians can shift by ±1 entity flipping
 * a single fact.
 *
 * Floats are rounded to 4 decimals before comparison so tests using
 * conventional fixtures (0.85 → 0.80 = drop 0.05) don't trip on
 * `0.85 - 0.80 === 0.04999999999999998` precision artifacts. 4 decimals
 * is comfortably finer than any granularity we'd report to a human
 * (we display medians to 2dp).
 */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function decide(
  baselineCov: CoverageSnapshot | null,
  candidateCov: CoverageSnapshot,
  baselineImprove: ImproveSnapshot | null,
  candidateImprove: ImproveSnapshot,
  override: BenchmarkSkip | null,
  thresholds: { coverage: number; verified: number },
): RegressionDecision {
  const reasons: string[] = [];

  if (!baselineCov || !baselineImprove) {
    return {
      verdict: "advisory",
      summary:
        "No baseline snapshots available — gate is advisory until the next " +
        "`improve-pipeline-baseline` cron run uploads a `main-latest` artifact.",
      reasons: [],
      delta: { median_coverage_score: null, median_verified_rate: null },
      thresholds,
      override,
    };
  }

  const baseCov = baselineCov.aggregate.median_coverage_score;
  const candCov = candidateCov.aggregate.median_coverage_score;
  const dCov =
    baseCov === null || candCov === null ? null : round4(candCov - baseCov);

  const baseVer = baselineImprove.aggregate.median_verified_rate;
  const candVer = candidateImprove.aggregate.median_verified_rate;
  const dVer = round4(candVer - baseVer);

  if (dCov !== null && dCov < -thresholds.coverage) {
    reasons.push(
      `median(coverage_score) dropped ${(-dCov).toFixed(3)} ` +
        `(${baseCov!.toFixed(3)} → ${candCov!.toFixed(3)}), ` +
        `threshold ${thresholds.coverage}.`,
    );
  }
  if (dVer < -thresholds.verified) {
    reasons.push(
      `median(verified_rate) dropped ${(-dVer * 100).toFixed(1)}pts ` +
        `(${(baseVer * 100).toFixed(1)} → ${(candVer * 100).toFixed(1)}), ` +
        `threshold ${(thresholds.verified * 100).toFixed(0)}pts.`,
    );
  }

  const delta = { median_coverage_score: dCov, median_verified_rate: dVer };

  if (reasons.length === 0) {
    return {
      verdict: "pass",
      summary: "✅ No regression detected.",
      reasons: [],
      delta,
      thresholds,
      override,
    };
  }

  if (override) {
    return {
      verdict: "override",
      summary: `⚠ Regression detected but bypassed via \`benchmark-skip\`: ${override.reason}`,
      reasons,
      delta,
      thresholds,
      override,
    };
  }

  return {
    verdict: "fail",
    summary: `❌ Regression detected (${reasons.length} threshold breach${reasons.length > 1 ? "es" : ""}).`,
    reasons,
    delta,
    thresholds,
    override: null,
  };
}

// ── Markdown formatting ─────────────────────────────────────────────────────

function fmt2(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function fmtDelta(before: number | null, after: number | null): string {
  if (before === null && after === null) return "—";
  if (before === null) return `**${fmt2(after)}** _(new)_`;
  if (after === null) return `${fmt2(before)} → **—** _(gone)_`;
  const d = after - before;
  const sign = d > 0 ? "+" : "";
  return `${fmt2(before)} → **${fmt2(after)}** (${sign}${d.toFixed(2)})`;
}

/**
 * Build the markdown body for the PR comment. Heading + verdict + aggregate
 * table + per-entity table. Stable HTML-comment marker so the workflow can
 * upsert (replace) prior comments instead of stacking.
 */
export function formatComment(
  decision: RegressionDecision,
  baselineCov: CoverageSnapshot | null,
  candidateCov: CoverageSnapshot,
  baselineImprove: ImproveSnapshot | null,
  candidateImprove: ImproveSnapshot,
): string {
  const lines: string[] = [];
  lines.push("<!-- improve-pipeline-benchmark:comment-marker -->");
  lines.push("## improve-entity pipeline benchmark");
  lines.push("");
  lines.push(decision.summary);
  if (decision.reasons.length > 0) {
    lines.push("");
    for (const r of decision.reasons) lines.push(`- ${r}`);
  }
  lines.push("");

  // Metadata table
  lines.push("| | baseline (main-latest) | candidate (this PR) |");
  lines.push("| --- | --- | --- |");
  lines.push(
    `| sha | \`${baselineCov?.git_sha ?? baselineImprove?.git_sha ?? "—"}\` | \`${candidateCov.git_sha ?? candidateImprove.git_sha ?? "—"}\` |`,
  );
  lines.push(
    `| improve-entity-suite | ${baselineImprove?.tag ?? "—"} | ${candidateImprove.tag} |`,
  );
  lines.push(
    `| benchmark-suite | ${baselineCov?.tag ?? "—"} | ${candidateCov.tag} |`,
  );
  lines.push(
    `| total cost (candidate) | — | $${candidateImprove.aggregate.total_cost_usd.toFixed(2)} |`,
  );
  lines.push(
    `| entities completed | — | ${candidateImprove.aggregate.entities_completed} ` +
      `(${candidateImprove.aggregate.entities_skipped_budget} skipped, ` +
      `${candidateImprove.aggregate.entities_failed} failed) |`,
  );
  lines.push("");

  // Aggregate deltas
  lines.push("### Aggregate");
  lines.push("");
  lines.push("| metric | before | after | delta |");
  lines.push("| --- | --- | --- | --- |");
  const baseCovMed = baselineCov?.aggregate.median_coverage_score ?? null;
  const candCovMed = candidateCov.aggregate.median_coverage_score;
  lines.push(
    `| median(coverage_score) | ${fmt2(baseCovMed)} | ${fmt2(candCovMed)} | ${fmtDeltaInline(baseCovMed, candCovMed)} |`,
  );
  const basePcov = baselineCov?.aggregate.p25_coverage_score ?? null;
  lines.push(
    `| p25(coverage_score) | ${fmt2(basePcov)} | ${fmt2(candidateCov.aggregate.p25_coverage_score)} | ${fmtDeltaInline(basePcov, candidateCov.aggregate.p25_coverage_score)} |`,
  );
  const baseVer = baselineImprove?.aggregate.median_verified_rate ?? null;
  const candVer = candidateImprove.aggregate.median_verified_rate;
  lines.push(
    `| median(verified_rate) | ${fmt2(baseVer)} | ${fmt2(candVer)} | ${fmtDeltaInline(baseVer, candVer)} |`,
  );
  lines.push("");

  // Per-entity coverage table (only entities scored in either snapshot)
  lines.push("### Per-entity coverage");
  lines.push("");
  lines.push("| slug | baseline | candidate | delta |");
  lines.push("| --- | --- | --- | --- |");
  const beforeBySlug = new Map(
    (baselineCov?.entities ?? []).map((e) => [e.slug, e]),
  );
  const afterBySlug = new Map(candidateCov.entities.map((e) => [e.slug, e]));
  const allSlugs = Array.from(
    new Set([...beforeBySlug.keys(), ...afterBySlug.keys()]),
  ).sort();
  for (const slug of allSlugs) {
    const b = beforeBySlug.get(slug)?.coverage_score ?? null;
    const a = afterBySlug.get(slug)?.coverage_score ?? null;
    lines.push(
      `| \`${slug}\` | ${fmt2(b)} | ${fmt2(a)} | ${fmtDeltaInline(b, a)} |`,
    );
  }
  lines.push("");

  // Override audit trail — only when the override actually fired
  if (decision.verdict === "override" && decision.override) {
    lines.push("### Override");
    lines.push("");
    lines.push(
      `This PR's description includes \`<!-- benchmark-skip: ${decision.override.reason} -->\`.` +
        ` The gate recorded the regression but did not block the PR.`,
    );
    lines.push("");
  }

  // Tail: how to override (only printed on fail so we don't advertise it on every passing run)
  if (decision.verdict === "fail") {
    lines.push("---");
    lines.push("");
    lines.push(
      "If this regression is intentional (e.g. a stricter pre-filter that " +
        "deliberately drops verified-rate to raise quality), add this " +
        "comment to the PR description and re-run the workflow:",
    );
    lines.push("");
    lines.push("```html");
    lines.push("<!-- benchmark-skip: short reason here -->");
    lines.push("```");
    lines.push("");
  }

  lines.push(
    `<sub>Thresholds: median(coverage_score) drop > ${decision.thresholds.coverage}, ` +
      `median(verified_rate) drop > ${(decision.thresholds.verified * 100).toFixed(0)}pts. ` +
      "Generated by [QUA-871](https://linear.app/quantifieduncertainty/issue/QUA-871).</sub>",
  );

  return lines.join("\n") + "\n";
}

function fmtDeltaInline(before: number | null, after: number | null): string {
  if (before === null && after === null) return "—";
  if (before === null) return "_new_";
  if (after === null) return "_gone_";
  const d = after - before;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(2)}`;
}

// ── I/O wrappers ────────────────────────────────────────────────────────────

function readSnapshot<T>(p: string, kind: string): T {
  const raw = fs.readFileSync(p, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(
      `Failed to parse ${kind} snapshot at ${p}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function readSnapshotIfExists<T>(p: string | undefined, kind: string): T | null {
  if (!p) return null;
  if (!fs.existsSync(p)) return null;
  return readSnapshot<T>(p, kind);
}

// ── CLI entry ───────────────────────────────────────────────────────────────

export async function run(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const baselineCovPath = options.baselineCoverage as string | undefined;
  const candidateCovPath = options.candidateCoverage as string | undefined;
  const baselineImprovePath = options.baselineImprove as string | undefined;
  const candidateImprovePath = options.candidateImprove as string | undefined;
  const prBodyFile = options.prBodyFile as string | undefined;
  const writeCommentFile = options.writeCommentFile as string | undefined;

  if (!candidateCovPath || !candidateImprovePath) {
    return {
      output:
        "Usage: crux tb pipeline-regression-check " +
        "--candidate-coverage=<file> --candidate-improve=<file> " +
        "[--baseline-coverage=<file>] [--baseline-improve=<file>] " +
        "[--pr-body-file=<file>] [--write-comment-file=<file>] " +
        "[--coverage-threshold=N] [--verified-threshold=N]",
      exitCode: 2,
    };
  }
  if (!fs.existsSync(candidateCovPath)) {
    return {
      output: `Candidate coverage snapshot not found: ${candidateCovPath}`,
      exitCode: 2,
    };
  }
  if (!fs.existsSync(candidateImprovePath)) {
    return {
      output: `Candidate improve snapshot not found: ${candidateImprovePath}`,
      exitCode: 2,
    };
  }

  const coverageThreshold = parseFloat(
    (options.coverageThreshold as string | undefined) ?? "0.05",
  );
  const verifiedThreshold = parseFloat(
    (options.verifiedThreshold as string | undefined) ?? "0.05",
  );
  if (!Number.isFinite(coverageThreshold) || coverageThreshold <= 0) {
    return {
      output: `--coverage-threshold must be a positive number; got ${options.coverageThreshold}`,
      exitCode: 2,
    };
  }
  if (
    !Number.isFinite(verifiedThreshold) ||
    verifiedThreshold <= 0 ||
    verifiedThreshold > 1
  ) {
    return {
      output:
        `--verified-threshold must be in (0, 1] (units: rate, not pct); got ${options.verifiedThreshold}`,
      exitCode: 2,
    };
  }

  const candidateCov = readSnapshot<CoverageSnapshot>(candidateCovPath, "candidate coverage");
  const candidateImprove = readSnapshot<ImproveSnapshot>(candidateImprovePath, "candidate improve");
  const baselineCov = readSnapshotIfExists<CoverageSnapshot>(baselineCovPath, "baseline coverage");
  const baselineImprove = readSnapshotIfExists<ImproveSnapshot>(baselineImprovePath, "baseline improve");

  let override: BenchmarkSkip | null = null;
  if (prBodyFile && fs.existsSync(prBodyFile)) {
    override = parseBenchmarkSkip(fs.readFileSync(prBodyFile, "utf8"));
  }

  const decision = decide(
    baselineCov,
    candidateCov,
    baselineImprove,
    candidateImprove,
    override,
    { coverage: coverageThreshold, verified: verifiedThreshold },
  );

  const comment = formatComment(
    decision,
    baselineCov,
    candidateCov,
    baselineImprove,
    candidateImprove,
  );

  if (writeCommentFile) {
    fs.mkdirSync(path.dirname(writeCommentFile), { recursive: true });
    fs.writeFileSync(writeCommentFile, comment);
  }

  // Always print the comment to stdout — workflow logs read it; humans
  // looking at the action run see the verdict without clicking through.
  console.log(comment);

  // Exit code: 1 only on hard fail. Override and advisory pass through.
  const exitCode = decision.verdict === "fail" ? 1 : 0;
  return { output: "", exitCode };
}

export function help(): CommandResult {
  return {
    output: `crux tb pipeline-regression-check
  --candidate-coverage=<file> --candidate-improve=<file>
  [--baseline-coverage=<file>] [--baseline-improve=<file>]
  [--pr-body-file=<file>] [--write-comment-file=<file>]
  [--coverage-threshold=0.05] [--verified-threshold=0.05]

Compare PR-side suite snapshots against baseline (main-latest) snapshots and
emit a markdown PR comment plus a pass/fail exit code. Powers the
\`.github/workflows/improve-pipeline-benchmark.yml\` gate (QUA-871).

Inputs are JSON files written by:
  - crux tb benchmark-suite --tag=<x>           (coverage_score)
  - crux tb improve-entity-suite --tag=<x>      (verified_rate)

Override: when the PR body contains
  <!-- benchmark-skip: <reason> -->
the gate records the regression but exits 0 so the PR isn't blocked.

If a baseline snapshot is missing (e.g. before the first cron run completes),
the gate runs in advisory mode and exits 0.

Exit codes:
  0  pass | override | advisory (no baseline)
  1  fail (regression beyond thresholds, no override)
  2  usage error / missing candidate snapshot
`,
    exitCode: 0,
  };
}

export const commands = { default: run, help };
export const getHelp = () => help().output;
