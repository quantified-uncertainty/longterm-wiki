// crux tb benchmark — measurement harness for entity-improvement pipeline changes.
//
// Usage:
//   crux tb benchmark fisa-702 --tag=before-token-filter
//   crux tb benchmark fisa-702 --diff=before-token-filter,after-token-filter
//   crux tb benchmark anthropic --tag=baseline           # organization
//
// Supported entity types: `policy`, `organization` (QUA-936). Other types
// reject with a clear error pointing at the expected follow-up tickets.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { type CommandResult } from "../lib/cli.ts";
import {
  coverageScoreForEntity,
  isSupportedCoverageType,
  SUPPORTED_COVERAGE_TYPES,
  type SupportedCoverageType,
} from "../lib/research/gap-analyzer.ts";
import { findEntity, type EntityWithType } from "../lib/research/entity-loader.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_BENCH_DIR = path.join(ROOT, ".claude/snapshots/benchmark");

/** Tag flows into the snapshot filename. Allowlist prevents path traversal
 *  and shell/filesystem surprises. Mirrors the suite-side check. */
const VALID_TAG_RE = /^[a-zA-Z0-9._-]+$/;
function isValidTag(tag: string): boolean {
  return tag.length > 0 && tag.length <= 80 && VALID_TAG_RE.test(tag);
}

/** Slug also flows into a directory path; same allowlist semantics. */
function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 200 && VALID_TAG_RE.test(slug);
}

export interface BenchmarkSnapshot {
  entity_slug: string;
  /** Entity type (`policy`, `organization`, ...). Added in QUA-936 so diff/list
   *  consumers don't have to re-look up the type. Optional on read because
   *  pre-QUA-936 snapshots don't carry it. */
  entity_type?: SupportedCoverageType;
  tag: string;
  timestamp: string;
  git_sha: string | null;
  coverage_score: number;
  components: Record<string, number>;
  facts_in_yaml: Record<string, number>;
  /** Raw YAML-loaded entity. Pre-QUA-936 this was always `PolicyEntity`; now
   *  it's any supported type — read `entity_type` to discriminate before
   *  accessing type-specific fields like `provisions` (policy) or
   *  `products` (organization). */
  yaml_excerpt: EntityWithType;
}

export interface SnapshotOptions {
  /** Override the snapshot dir (tests). Default: `.claude/snapshots/benchmark`. */
  benchDir?: string;
  /** Override the entities dir (tests). Default: `data/entities`. */
  entitiesDir?: string;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function entityDir(slug: string, benchDir: string): string {
  const dir = path.join(benchDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listSnapshots(slug: string, opts: SnapshotOptions = {}): BenchmarkSnapshot[] {
  if (!isValidSlug(slug)) return [];
  const dir = entityDir(slug, opts.benchDir ?? DEFAULT_BENCH_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as BenchmarkSnapshot)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function findByTag(
  slug: string,
  tag: string,
  opts: SnapshotOptions = {},
): BenchmarkSnapshot | null {
  return listSnapshots(slug, opts).find((s) => s.tag === tag) ?? null;
}

export function takeSnapshot(
  slug: string,
  tag: string,
  opts: SnapshotOptions = {},
): BenchmarkSnapshot {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid slug "${slug}": must match ${VALID_TAG_RE} and be 1-200 chars.`);
  }
  if (!isValidTag(tag)) {
    throw new Error(`Invalid --tag "${tag}": must match ${VALID_TAG_RE} and be 1-80 chars.`);
  }
  const entity = findEntity(slug, opts.entitiesDir);
  if (!entity) throw new Error(`Entity not found: ${slug}`);
  if (!isSupportedCoverageType(entity.type)) {
    throw new Error(
      `Type "${entity.type}" not supported in benchmark v1 (supported: ${SUPPORTED_COVERAGE_TYPES.join(", ")})`,
    );
  }
  const cov = coverageScoreForEntity(entity);
  // isSupportedCoverageType already vetted entity.type, so coverageScoreForEntity
  // cannot return null here — but guard anyway so a future scorer registration
  // mismatch produces a clear error rather than a silent NaN.
  if (!cov) throw new Error(`No coverage scorer registered for type "${entity.type}"`);
  const snap: BenchmarkSnapshot = {
    entity_slug: slug,
    entity_type: entity.type,
    tag,
    timestamp: new Date().toISOString(),
    git_sha: gitSha(),
    coverage_score: cov.score,
    components: cov.components,
    facts_in_yaml: cov.facts_in_yaml,
    yaml_excerpt: entity,
  };
  const stamp = snap.timestamp.replace(/[:.]/g, "-");
  fs.writeFileSync(
    path.join(entityDir(slug, opts.benchDir ?? DEFAULT_BENCH_DIR), `${stamp}__${tag}.json`),
    JSON.stringify(snap, null, 2) + "\n",
  );
  return snap;
}

function fmtDelta(before: number, after: number): string {
  const d = after - before;
  const sign = d > 0 ? "+" : "";
  return `${before} → ${after}  (${sign}${d.toFixed(2)})`;
}

export function diff(
  slug: string,
  beforeTag: string,
  afterTag: string,
  opts: SnapshotOptions = {},
): string {
  const before = findByTag(slug, beforeTag, opts);
  const after = findByTag(slug, afterTag, opts);
  if (!before) return `No snapshot tagged "${beforeTag}" for ${slug}`;
  if (!after) return `No snapshot tagged "${afterTag}" for ${slug}`;
  const lines: string[] = [];
  const typeNote = before.entity_type ?? after.entity_type;
  lines.push(`=== ${slug}${typeNote ? ` (${typeNote})` : ""}: ${beforeTag} → ${afterTag} ===`);
  lines.push(`coverage_score      ${fmtDelta(before.coverage_score, after.coverage_score)}`);
  lines.push("components:");
  for (const k of Object.keys({ ...before.components, ...after.components })) {
    lines.push(`  ${k.padEnd(20)} ${fmtDelta(before.components[k] ?? 0, after.components[k] ?? 0)}`);
  }
  lines.push("facts_in_yaml:");
  for (const k of Object.keys({ ...before.facts_in_yaml, ...after.facts_in_yaml })) {
    lines.push(`  ${k.padEnd(20)} ${fmtDelta(before.facts_in_yaml[k] ?? 0, after.facts_in_yaml[k] ?? 0)}`);
  }
  return lines.join("\n");
}

export async function run(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const slug = (args[0] || "").trim();
  if (!slug) {
    return { output: "Usage: crux tb benchmark <slug> --tag=<label> | --diff=<a>,<b>", exitCode: 1 };
  }
  if (options.list) {
    const snaps = listSnapshots(slug);
    if (snaps.length === 0) return { output: `No snapshots for ${slug}`, exitCode: 0 };
    const out = snaps
      .map((s) => {
        const typeStr = s.entity_type ? ` type=${s.entity_type}` : "";
        return `  ${s.timestamp}  ${s.tag.padEnd(30)}${typeStr}  cov=${s.coverage_score}  facts=${JSON.stringify(s.facts_in_yaml)}`;
      })
      .join("\n");
    return { output: out, exitCode: 0 };
  }
  if (options.diff) {
    const [a, b] = String(options.diff).split(",").map((s) => s.trim());
    if (!a || !b) return { output: "Usage: --diff=<beforeTag>,<afterTag>", exitCode: 1 };
    return { output: diff(slug, a, b), exitCode: 0 };
  }
  const tag = String(options.tag ?? "").trim();
  if (!tag) return { output: "Provide --tag=<label> | --diff=<a>,<b> | --list", exitCode: 1 };
  let snap: BenchmarkSnapshot;
  try {
    snap = takeSnapshot(slug, tag);
  } catch (e) {
    return { output: `benchmark: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 };
  }
  return {
    output: `Snapshot saved for ${slug} (${snap.entity_type}) [${tag}]:
  coverage_score: ${snap.coverage_score}
  facts_in_yaml: ${JSON.stringify(snap.facts_in_yaml)}
  components: ${JSON.stringify(snap.components)}`,
    exitCode: 0,
  };
}

export function help(): CommandResult {
  return {
    output: `crux tb benchmark <slug> --tag=<label>     Take a snapshot
crux tb benchmark <slug> --list             List snapshots
crux tb benchmark <slug> --diff=<a>,<b>     Diff two tags

Supported entity types: ${SUPPORTED_COVERAGE_TYPES.join(", ")}
`,
    exitCode: 0,
  };
}

export const commands = { default: run, help };
export const getHelp = () => help().output;
