// crux tb benchmark-suite — multi-entity read-only snapshot + diff harness.
//
// Reads the committed list at crux/benchmarks/entity-suite.yaml, computes a
// coverage score for each entity from its data/entities/*.yaml row, and
// persists a single aggregate snapshot under
// .claude/snapshots/benchmark-suite/<tag>.json.
//
// Pure-read by design: no LLM calls, no network, no writes outside the
// snapshot directory. See QUA-873 for the parent ticket; the runner that
// actually invokes the improve-entity loop across the suite is a separate
// follow-up.
//
// Usage:
//   pnpm crux tb benchmark-suite --tag=baseline
//   pnpm crux tb benchmark-suite --diff=baseline,after-X
//   pnpm crux tb benchmark-suite --list

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { execSync } from "node:child_process";

import { type CommandResult } from "../lib/cli.ts";
import { policyCoverageScore, type PolicyEntity } from "../lib/research/gap-analyzer.ts";
import {
  computeAggregate,
  type SuiteAggregate,
  type SuiteEntityResult,
} from "../lib/research/benchmark-aggregate.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SUITE_YAML = path.join(ROOT, "crux/benchmarks/entity-suite.yaml");
const RESPONSES_YAML = path.join(ROOT, "data/entities/responses.yaml");
const SNAPSHOT_DIR = path.join(ROOT, ".claude/snapshots/benchmark-suite");

interface SuiteEntry {
  slug: string;
  type: string;
  expected_min_coverage: number;
}

interface SuiteSnapshotEntity extends SuiteEntityResult {
  components: Record<string, number>;
  facts_in_yaml: Record<string, number>;
}

interface SuiteSnapshot {
  tag: string;
  timestamp: string;
  git_sha: string | null;
  suite_size: number;
  entities: SuiteSnapshotEntity[];
  aggregate: SuiteAggregate;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function loadSuite(): SuiteEntry[] {
  if (!fs.existsSync(SUITE_YAML)) {
    throw new Error(`Suite definition not found: ${SUITE_YAML}`);
  }
  const raw = yaml.load(fs.readFileSync(SUITE_YAML, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`Suite definition is not a YAML list: ${SUITE_YAML}`);
  }
  for (const e of raw) {
    if (!e || typeof e !== "object") {
      throw new Error("Suite entry is not an object");
    }
    const r = e as Record<string, unknown>;
    if (typeof r.slug !== "string" || !r.slug) throw new Error("Suite entry missing slug");
    if (typeof r.type !== "string" || !r.type) {
      throw new Error(`Suite entry "${r.slug}" missing type`);
    }
    if (typeof r.expected_min_coverage !== "number") {
      throw new Error(`Suite entry "${r.slug}" missing expected_min_coverage`);
    }
    if (r.expected_min_coverage < 0 || r.expected_min_coverage > 1) {
      throw new Error(
        `Suite entry "${r.slug}" expected_min_coverage out of range [0,1]: ${r.expected_min_coverage}`,
      );
    }
  }
  return raw as SuiteEntry[];
}

function loadPolicies(): Map<string, PolicyEntity> {
  const all = yaml.load(fs.readFileSync(RESPONSES_YAML, "utf8")) as PolicyEntity[];
  const map = new Map<string, PolicyEntity>();
  for (const e of all) map.set(e.id, e);
  return map;
}

function snapshotPath(tag: string): string {
  return path.join(SNAPSHOT_DIR, `${tag}.json`);
}

function listSnapshots(): SuiteSnapshot[] {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, f), "utf8")) as SuiteSnapshot)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function findByTag(tag: string): SuiteSnapshot | null {
  const p = snapshotPath(tag);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as SuiteSnapshot;
}

/**
 * Build a full suite snapshot. Pure: reads YAML, computes coverage, returns
 * the snapshot object. Caller decides whether to persist.
 */
export function buildSnapshot(tag: string): SuiteSnapshot {
  const suite = loadSuite();
  const policies = loadPolicies();
  const entities: SuiteSnapshotEntity[] = [];
  for (const entry of suite) {
    if (entry.type !== "policy") {
      // v1 is policy-only. Other types arrive in QUA-876 and follow-ups; until
      // then, surface non-policy entries as a hard error so a typo'd suite
      // doesn't silently skip rows.
      throw new Error(
        `Suite entry "${entry.slug}" has unsupported type "${entry.type}" (v1 is policy-only)`,
      );
    }
    const e = policies.get(entry.slug);
    if (!e) {
      throw new Error(`Suite entry "${entry.slug}" not found in data/entities/responses.yaml`);
    }
    const cov = policyCoverageScore(e);
    entities.push({
      slug: entry.slug,
      type: entry.type,
      coverage_score: cov.score,
      expected_min_coverage: entry.expected_min_coverage,
      components: cov.components,
      facts_in_yaml: cov.facts_in_yaml,
    });
  }
  return {
    tag,
    timestamp: new Date().toISOString(),
    git_sha: gitSha(),
    suite_size: suite.length,
    entities,
    aggregate: computeAggregate(entities),
  };
}

function writeSnapshot(snap: SuiteSnapshot): string {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const p = snapshotPath(snap.tag);
  fs.writeFileSync(p, JSON.stringify(snap, null, 2) + "\n");
  return p;
}

function fmtScore(n: number): string {
  return n.toFixed(2);
}

function fmtDelta(before: number, after: number, digits = 2): string {
  const d = after - before;
  const sign = d > 0 ? "+" : d < 0 ? "" : " ";
  return `${before.toFixed(digits)} → ${after.toFixed(digits)}  (${sign}${d.toFixed(digits)})`;
}

function fmtIntDelta(before: number, after: number): string {
  const d = after - before;
  const sign = d > 0 ? "+" : d < 0 ? "" : " ";
  return `${before} → ${after}  (${sign}${d})`;
}

function formatSnapshotSummary(snap: SuiteSnapshot): string {
  const lines: string[] = [];
  lines.push(`Snapshot saved: ${snap.tag}`);
  lines.push(`  timestamp: ${snap.timestamp}`);
  lines.push(`  git_sha:   ${snap.git_sha ?? "(none)"}`);
  lines.push(`  size:      ${snap.suite_size}`);
  lines.push("  per-entity:");
  // Pad slug column for readability.
  const w = Math.max(...snap.entities.map((e) => e.slug.length), 4);
  for (const e of snap.entities) {
    const flag = e.coverage_score < e.expected_min_coverage ? " ✗ below min" : "";
    lines.push(
      `    ${e.slug.padEnd(w)}  cov=${fmtScore(e.coverage_score)}  min=${fmtScore(
        e.expected_min_coverage,
      )}${flag}`,
    );
  }
  lines.push("  aggregate:");
  lines.push(`    median_coverage_score: ${fmtScore(snap.aggregate.median_coverage_score)}`);
  lines.push(`    p25_coverage_score:    ${fmtScore(snap.aggregate.p25_coverage_score)}`);
  lines.push(`    count_below_min:       ${snap.aggregate.count_below_min}`);
  if (snap.aggregate.below_min_slugs.length) {
    lines.push(`    below_min_slugs:       ${snap.aggregate.below_min_slugs.join(", ")}`);
  }
  return lines.join("\n");
}

function formatList(snaps: SuiteSnapshot[]): string {
  if (snaps.length === 0) return "No suite snapshots in .claude/snapshots/benchmark-suite/";
  const lines: string[] = ["Suite snapshots:"];
  const wTag = Math.max(...snaps.map((s) => s.tag.length), 3);
  for (const s of snaps) {
    lines.push(
      `  ${s.timestamp}  ${s.tag.padEnd(wTag)}  size=${s.suite_size}  median=${fmtScore(
        s.aggregate.median_coverage_score,
      )}  p25=${fmtScore(s.aggregate.p25_coverage_score)}  below=${s.aggregate.count_below_min}`,
    );
  }
  return lines.join("\n");
}

function formatDiff(before: SuiteSnapshot, after: SuiteSnapshot): string {
  const lines: string[] = [];
  lines.push(`=== suite diff: ${before.tag} → ${after.tag} ===`);
  lines.push(`  before: ${before.timestamp}  git=${before.git_sha ?? "?"}`);
  lines.push(`  after:  ${after.timestamp}  git=${after.git_sha ?? "?"}`);
  // Per-entity table — align by union of slugs so dropped/added entities show.
  const beforeBySlug = new Map(before.entities.map((e) => [e.slug, e] as const));
  const afterBySlug = new Map(after.entities.map((e) => [e.slug, e] as const));
  const allSlugs = Array.from(new Set([...beforeBySlug.keys(), ...afterBySlug.keys()])).sort();
  const w = Math.max(...allSlugs.map((s) => s.length), 4);
  lines.push("");
  lines.push("Per-entity coverage:");
  for (const slug of allSlugs) {
    const b = beforeBySlug.get(slug);
    const a = afterBySlug.get(slug);
    if (b && a) {
      lines.push(`  ${slug.padEnd(w)}  ${fmtDelta(b.coverage_score, a.coverage_score)}`);
    } else if (!b && a) {
      lines.push(`  ${slug.padEnd(w)}  (added)         ${fmtScore(a.coverage_score)}`);
    } else if (b && !a) {
      lines.push(`  ${slug.padEnd(w)}  ${fmtScore(b.coverage_score)} → (removed)`);
    }
  }
  lines.push("");
  lines.push("Aggregate:");
  lines.push(
    `  median           ${fmtDelta(
      before.aggregate.median_coverage_score,
      after.aggregate.median_coverage_score,
    )}`,
  );
  lines.push(
    `  p25              ${fmtDelta(
      before.aggregate.p25_coverage_score,
      after.aggregate.p25_coverage_score,
    )}`,
  );
  lines.push(
    `  count_below_min  ${fmtIntDelta(
      before.aggregate.count_below_min,
      after.aggregate.count_below_min,
    )}`,
  );
  // Show set diff on below_min_slugs so a regression shows the offender.
  const beforeSet = new Set(before.aggregate.below_min_slugs);
  const afterSet = new Set(after.aggregate.below_min_slugs);
  const newlyBelow = [...afterSet].filter((s) => !beforeSet.has(s)).sort();
  const recovered = [...beforeSet].filter((s) => !afterSet.has(s)).sort();
  if (newlyBelow.length) lines.push(`  newly below min: ${newlyBelow.join(", ")}`);
  if (recovered.length) lines.push(`  recovered:       ${recovered.join(", ")}`);
  return lines.join("\n");
}

export async function run(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  void args;

  if (options.list) {
    return { output: formatList(listSnapshots()), exitCode: 0 };
  }

  if (options.diff) {
    const [a, b] = String(options.diff).split(",").map((s) => s.trim());
    if (!a || !b) {
      return { output: "Usage: --diff=<beforeTag>,<afterTag>", exitCode: 1 };
    }
    const before = findByTag(a);
    const after = findByTag(b);
    if (!before) return { output: `No suite snapshot tagged "${a}"`, exitCode: 1 };
    if (!after) return { output: `No suite snapshot tagged "${b}"`, exitCode: 1 };
    return { output: formatDiff(before, after), exitCode: 0 };
  }

  const tag = String(options.tag ?? "").trim();
  if (!tag) {
    return {
      output: "Provide --tag=<label> | --diff=<a>,<b> | --list",
      exitCode: 1,
    };
  }
  // Tag must be path-safe — it becomes a filename.
  if (!/^[a-zA-Z0-9._-]+$/.test(tag)) {
    return {
      output: `Tag must match [a-zA-Z0-9._-]+ (got: "${tag}")`,
      exitCode: 1,
    };
  }

  const snap = buildSnapshot(tag);
  const filePath = writeSnapshot(snap);
  return {
    output: `${formatSnapshotSummary(snap)}\n  written: ${path.relative(ROOT, filePath)}`,
    exitCode: 0,
  };
}

export function help(): CommandResult {
  return {
    output: `crux tb benchmark-suite --tag=<label>     Snapshot the suite
crux tb benchmark-suite --list             List suite snapshots
crux tb benchmark-suite --diff=<a>,<b>     Diff two suite tags
`,
    exitCode: 0,
  };
}

export const commands = { default: run, help };
export const getHelp = () => help().output;
