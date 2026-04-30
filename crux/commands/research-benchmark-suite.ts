// crux tb benchmark-suite — read-only multi-entity coverage measurement.
//
// QUA-873. Pairs with `crux tb improve-entity-suite` (QUA-882) and the
// CI gate (QUA-871). This command does NOT call any LLM; it reads YAML
// state and computes per-entity + aggregate coverage scores.
//
// Usage:
//   pnpm crux tb benchmark-suite --tag=baseline
//   pnpm crux tb benchmark-suite --diff=before,after
//   pnpm crux tb benchmark-suite --list

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import yaml from "js-yaml";
import { z } from "zod";

import { type CommandResult } from "../lib/cli.ts";
import {
  policyCoverageScore,
  type CoverageScore,
  type PolicyEntity,
} from "../lib/research/gap-analyzer.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_SUITE_YAML = path.join(ROOT, "crux/benchmarks/entity-suite.yaml");
const DEFAULT_RESPONSES_YAML = path.join(ROOT, "data/entities/responses.yaml");
const DEFAULT_SNAPSHOT_DIR = path.join(ROOT, ".claude/snapshots/benchmark-suite");

// ── Suite YAML schema ───────────────────────────────────────────────────────

const SuiteEntrySchema = z.object({
  slug: z.string().min(1),
  type: z.string().min(1),
  expected_min_coverage: z.number().min(0).max(1).optional(),
});
const SuiteSchema = z.array(SuiteEntrySchema);

export type SuiteEntry = z.infer<typeof SuiteEntrySchema>;

/** Types that have a coverage scorer. v1: policy-only. */
const SUPPORTED_TYPES = new Set<string>(["policy"]);

/** Tag flows into the snapshot filename. Reject anything that could escape
 *  the snapshot dir (path separators, traversal sequences) or cause shell /
 *  filesystem surprises. Allowlist matches typical labels. */
const VALID_TAG_RE = /^[a-zA-Z0-9._-]+$/;
export function isValidTag(tag: string): boolean {
  return tag.length > 0 && tag.length <= 80 && VALID_TAG_RE.test(tag);
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export function loadSuite(filePath: string = DEFAULT_SUITE_YAML): SuiteEntry[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = yaml.load(raw);
  return SuiteSchema.parse(parsed);
}

export function loadResponses(filePath: string = DEFAULT_RESPONSES_YAML): PolicyEntity[] {
  const parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`responses YAML at ${filePath} must be an array of entities`);
  }
  return parsed as PolicyEntity[];
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (e) {
    // Not in a git checkout, or git not installed. Snapshot is still valid;
    // git_sha is informational. Don't crash the command.
    void e;
    return null;
  }
}

/** Median of a numeric list. Empty list → null. Even count averages the two middle values. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  if (sorted.length % 2 === 1) return sorted[Math.floor(mid)];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 25th percentile via linear interpolation on sorted list. Empty → null. */
export function p25(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = 0.25 * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── Per-entity scoring ──────────────────────────────────────────────────────

export interface PerEntityRecord {
  slug: string;
  type: string;
  /** null if entity wasn't found or type isn't supported. */
  coverage_score: number | null;
  components: Record<string, number>;
  facts_in_yaml: Record<string, number>;
  expected_min_coverage?: number;
  status: "scored" | "missing_entity" | "unsupported_type";
}

/**
 * Score every entry in `suite` against `responses`. Returns a record per entry.
 * Entries with unsupported types or missing responses get `status` set and
 * `coverage_score: null`.
 */
export function scoreSuite(
  suite: SuiteEntry[],
  responses: PolicyEntity[],
): PerEntityRecord[] {
  // responses.yaml stores its primary key as `id` but the suite YAML calls
  // the same string `slug` — they're the same value, just renamed at the
  // boundary. Index by the `id` column.
  const responsesById = new Map(responses.map((r) => [r.id, r]));
  return suite.map((entry) => {
    if (!SUPPORTED_TYPES.has(entry.type)) {
      return {
        slug: entry.slug,
        type: entry.type,
        coverage_score: null,
        components: {},
        facts_in_yaml: {},
        expected_min_coverage: entry.expected_min_coverage,
        status: "unsupported_type" as const,
      };
    }
    const ent = responsesById.get(entry.slug);
    if (!ent) {
      return {
        slug: entry.slug,
        type: entry.type,
        coverage_score: null,
        components: {},
        facts_in_yaml: {},
        expected_min_coverage: entry.expected_min_coverage,
        status: "missing_entity" as const,
      };
    }
    const cov: CoverageScore = policyCoverageScore(ent);
    return {
      slug: entry.slug,
      type: entry.type,
      coverage_score: cov.score,
      components: cov.components,
      facts_in_yaml: cov.facts_in_yaml,
      expected_min_coverage: entry.expected_min_coverage,
      status: "scored" as const,
    };
  });
}

// ── Aggregate ───────────────────────────────────────────────────────────────

export interface AggregateMetrics {
  scored_count: number;
  unsupported_count: number;
  missing_count: number;
  median_coverage_score: number | null;
  p25_coverage_score: number | null;
  count_below_min: number;
  below_min_slugs: string[];
}

export function computeAggregate(records: PerEntityRecord[]): AggregateMetrics {
  const scored = records.filter(
    (r) =>
      r.status === "scored" &&
      r.coverage_score !== null &&
      Number.isFinite(r.coverage_score),
  );
  const scores = scored.map((r) => r.coverage_score as number);
  const belowMin = scored.filter((r) => {
    if (r.expected_min_coverage === undefined || r.coverage_score === null) return false;
    return r.coverage_score < r.expected_min_coverage;
  });
  return {
    scored_count: scored.length,
    unsupported_count: records.filter((r) => r.status === "unsupported_type").length,
    missing_count: records.filter((r) => r.status === "missing_entity").length,
    median_coverage_score: median(scores),
    p25_coverage_score: p25(scores),
    count_below_min: belowMin.length,
    below_min_slugs: belowMin.map((r) => r.slug),
  };
}

// ── Snapshot persistence ────────────────────────────────────────────────────

export interface SuiteSnapshot {
  tag: string;
  timestamp: string;
  git_sha: string | null;
  suite_size: number;
  entities: PerEntityRecord[];
  aggregate: AggregateMetrics;
}

export function buildSnapshot(
  tag: string,
  records: PerEntityRecord[],
): SuiteSnapshot {
  return {
    tag,
    timestamp: new Date().toISOString(),
    git_sha: gitSha(),
    suite_size: records.length,
    entities: records,
    aggregate: computeAggregate(records),
  };
}

export function snapshotPath(snapshotDir: string, snap: SuiteSnapshot): string {
  const stamp = snap.timestamp.replace(/[:.]/g, "-");
  return path.join(snapshotDir, `${stamp}__${snap.tag}.json`);
}

export function writeSnapshot(snapshotDir: string, snap: SuiteSnapshot): string {
  fs.mkdirSync(snapshotDir, { recursive: true });
  let file = snapshotPath(snapshotDir, snap);
  // Two writes within the same millisecond with the same tag would otherwise
  // overwrite each other silently. Append a numeric suffix on collision.
  if (fs.existsSync(file)) {
    const base = file.replace(/\.json$/, "");
    let i = 1;
    while (fs.existsSync(`${base}__${i}.json`)) i++;
    file = `${base}__${i}.json`;
  }
  fs.writeFileSync(file, JSON.stringify(snap, null, 2) + "\n", { flag: "wx" });
  return file;
}

export function listSnapshotsInDir(snapshotDir: string): SuiteSnapshot[] {
  if (!fs.existsSync(snapshotDir)) return [];
  const out: SuiteSnapshot[] = [];
  for (const f of fs.readdirSync(snapshotDir)) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(snapshotDir, f);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as SuiteSnapshot;
      out.push(parsed);
    } catch (e) {
      // Skip malformed snapshot files rather than crashing --list / --diff.
      console.warn(
        `[benchmark-suite] skipping malformed snapshot ${f}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Returns the **latest** snapshot for a given tag (last write wins).
 * Same-tag re-runs (e.g. recomputing `baseline` after a pull) are common
 * enough that returning the earliest match would be surprising.
 */
export function findSnapshotByTag(snapshotDir: string, tag: string): SuiteSnapshot | null {
  const snaps = listSnapshotsInDir(snapshotDir).filter((s) => s.tag === tag);
  return snaps.length === 0 ? null : snaps[snaps.length - 1];
}

// ── Output formatting ───────────────────────────────────────────────────────

function fmt2(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(2);
}

function fmtDelta(before: number | null, after: number | null): string {
  if (before === null && after === null) return "—  →  —";
  if (before === null) return `—  →  ${fmt2(after)}  (new)`;
  if (after === null) return `${fmt2(before)}  →  —  (gone)`;
  const d = after - before;
  const sign = d > 0 ? "+" : "";
  return `${fmt2(before)}  →  ${fmt2(after)}  (${sign}${d.toFixed(2)})`;
}

export function formatSnapshotSummary(snap: SuiteSnapshot): string {
  const lines: string[] = [];
  lines.push(`Snapshot tag=${snap.tag} sha=${snap.git_sha ?? "?"} (${snap.suite_size} entries)`);
  lines.push(
    `  scored=${snap.aggregate.scored_count}` +
      `  unsupported=${snap.aggregate.unsupported_count}` +
      `  missing=${snap.aggregate.missing_count}`,
  );
  lines.push(
    `  median=${fmt2(snap.aggregate.median_coverage_score)}` +
      `  p25=${fmt2(snap.aggregate.p25_coverage_score)}` +
      `  below_min=${snap.aggregate.count_below_min}` +
      (snap.aggregate.below_min_slugs.length
        ? `  (${snap.aggregate.below_min_slugs.join(", ")})`
        : ""),
  );
  return lines.join("\n");
}

export function formatDiff(before: SuiteSnapshot, after: SuiteSnapshot): string {
  const lines: string[] = [];
  lines.push(`=== suite diff: ${before.tag} → ${after.tag} ===`);
  lines.push(`  before sha=${before.git_sha ?? "?"} (${before.timestamp})`);
  lines.push(`  after  sha=${after.git_sha ?? "?"} (${after.timestamp})`);
  lines.push("");
  // Per-entity table.
  const slugWidth = Math.max(
    8,
    ...before.entities.map((e) => e.slug.length),
    ...after.entities.map((e) => e.slug.length),
  );
  lines.push(`  ${"slug".padEnd(slugWidth)}  coverage`);
  lines.push(`  ${"-".repeat(slugWidth)}  ${"-".repeat(28)}`);
  // Index by slug.
  const beforeBySlug = new Map(before.entities.map((e) => [e.slug, e]));
  const afterBySlug = new Map(after.entities.map((e) => [e.slug, e]));
  const allSlugs = Array.from(new Set([...beforeBySlug.keys(), ...afterBySlug.keys()])).sort();
  for (const slug of allSlugs) {
    const b = beforeBySlug.get(slug);
    const a = afterBySlug.get(slug);
    lines.push(`  ${slug.padEnd(slugWidth)}  ${fmtDelta(b?.coverage_score ?? null, a?.coverage_score ?? null)}`);
  }
  lines.push("");
  lines.push("Aggregate:");
  lines.push(`  median   ${fmtDelta(before.aggregate.median_coverage_score, after.aggregate.median_coverage_score)}`);
  lines.push(`  p25      ${fmtDelta(before.aggregate.p25_coverage_score, after.aggregate.p25_coverage_score)}`);
  const cbm = after.aggregate.count_below_min - before.aggregate.count_below_min;
  const cbmSign = cbm > 0 ? "+" : "";
  lines.push(
    `  below_min  ${before.aggregate.count_below_min} → ${after.aggregate.count_below_min}  (${cbmSign}${cbm})`,
  );
  if (after.aggregate.below_min_slugs.length) {
    lines.push(`  below_min slugs (after): ${after.aggregate.below_min_slugs.join(", ")}`);
  }
  return lines.join("\n");
}

// ── CLI entry ───────────────────────────────────────────────────────────────

export interface RunOptions {
  suitePath?: string;
  responsesPath?: string;
  snapshotDir?: string;
}

/** Take a snapshot of the suite. Returns the snapshot + the file written. */
export function takeSnapshot(
  tag: string,
  opts: RunOptions = {},
): { snap: SuiteSnapshot; file: string } {
  if (!isValidTag(tag)) {
    throw new Error(`Invalid --tag "${tag}": must match ${VALID_TAG_RE} and be 1-80 chars.`);
  }
  const suite = loadSuite(opts.suitePath ?? DEFAULT_SUITE_YAML);
  const responses = loadResponses(opts.responsesPath ?? DEFAULT_RESPONSES_YAML);
  const records = scoreSuite(suite, responses);
  const snap = buildSnapshot(tag, records);
  const file = writeSnapshot(opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR, snap);
  return { snap, file };
}

export async function run(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const snapshotDir = DEFAULT_SNAPSHOT_DIR;

  if (options.list) {
    const snaps = listSnapshotsInDir(snapshotDir);
    if (snaps.length === 0) {
      return { output: "No snapshots in benchmark-suite/", exitCode: 0 };
    }
    const out = snaps
      .map(
        (s) =>
          `  ${s.timestamp}  ${s.tag.padEnd(30)}  ` +
          `median=${fmt2(s.aggregate.median_coverage_score)}  ` +
          `p25=${fmt2(s.aggregate.p25_coverage_score)}  ` +
          `below_min=${s.aggregate.count_below_min}  ` +
          `(scored=${s.aggregate.scored_count}/${s.suite_size})`,
      )
      .join("\n");
    return { output: out, exitCode: 0 };
  }

  if (options.diff) {
    const [a, b] = String(options.diff)
      .split(",")
      .map((s) => s.trim());
    if (!a || !b) {
      return { output: "Usage: --diff=<beforeTag>,<afterTag>", exitCode: 1 };
    }
    // Symmetric with the write-side allowlist — keeps the contract consistent.
    if (!isValidTag(a) || !isValidTag(b)) {
      return {
        output: `Invalid tag in --diff: tags must match ${VALID_TAG_RE} and be 1-80 chars.`,
        exitCode: 1,
      };
    }
    const before = findSnapshotByTag(snapshotDir, a);
    const after = findSnapshotByTag(snapshotDir, b);
    if (!before) return { output: `No snapshot tagged "${a}".`, exitCode: 1 };
    if (!after) return { output: `No snapshot tagged "${b}".`, exitCode: 1 };
    return { output: formatDiff(before, after), exitCode: 0 };
  }

  const tag = String(options.tag ?? "").trim();
  if (!tag) {
    return {
      output:
        "Usage: crux tb benchmark-suite --tag=<label> | --diff=<a>,<b> | --list",
      exitCode: 1,
    };
  }

  try {
    const { snap, file } = takeSnapshot(tag);
    return {
      output: `${formatSnapshotSummary(snap)}\nWrote ${path.relative(ROOT, file)}`,
      exitCode: 0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: `benchmark-suite: ${msg}`, exitCode: 1 };
  }
}

export function help(): CommandResult {
  return {
    output: `crux tb benchmark-suite --tag=<label>     Snapshot the suite
crux tb benchmark-suite --diff=<a>,<b>     Diff two snapshots (per-entity + aggregate)
crux tb benchmark-suite --list             List snapshots
`,
    exitCode: 0,
  };
}

export const commands = { default: run, help };
export const getHelp = () => help().output;
