// crux tb benchmark — measurement harness for entity-improvement pipeline changes.
//
// Usage:
//   crux tb benchmark fisa-702 --tag=before-token-filter
//   crux tb benchmark fisa-702 --diff=before-token-filter,after-token-filter

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { execSync } from "node:child_process";

import { type CommandResult } from "../lib/cli.ts";
import { policyCoverageScore, type PolicyEntity } from "../lib/research/gap-analyzer.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RESPONSES_YAML = path.join(ROOT, "data/entities/responses.yaml");
const BENCH_DIR = path.join(ROOT, ".claude/snapshots/benchmark");

interface BenchmarkSnapshot {
  entity_slug: string;
  tag: string;
  timestamp: string;
  git_sha: string | null;
  coverage_score: number;
  components: Record<string, number>;
  facts_in_yaml: Record<string, number>;
  yaml_excerpt: PolicyEntity;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function loadEntity(slug: string): PolicyEntity | null {
  const all = yaml.load(fs.readFileSync(RESPONSES_YAML, "utf8")) as PolicyEntity[];
  return all.find((e) => e.id === slug) ?? null;
}

function entityDir(slug: string): string {
  const dir = path.join(BENCH_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listSnapshots(slug: string): BenchmarkSnapshot[] {
  const dir = entityDir(slug);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as BenchmarkSnapshot)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function findByTag(slug: string, tag: string): BenchmarkSnapshot | null {
  return listSnapshots(slug).find((s) => s.tag === tag) ?? null;
}

function takeSnapshot(slug: string, tag: string): BenchmarkSnapshot {
  const entity = loadEntity(slug);
  if (!entity) throw new Error(`Entity not found: ${slug}`);
  const cov = policyCoverageScore(entity);
  const snap: BenchmarkSnapshot = {
    entity_slug: slug,
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
    path.join(entityDir(slug), `${stamp}__${tag}.json`),
    JSON.stringify(snap, null, 2) + "\n",
  );
  return snap;
}

function fmtDelta(before: number, after: number): string {
  const d = after - before;
  const sign = d > 0 ? "+" : "";
  return `${before} → ${after}  (${sign}${d.toFixed(2)})`;
}

function diff(slug: string, beforeTag: string, afterTag: string): string {
  const before = findByTag(slug, beforeTag);
  const after = findByTag(slug, afterTag);
  if (!before) return `No snapshot tagged "${beforeTag}" for ${slug}`;
  if (!after) return `No snapshot tagged "${afterTag}" for ${slug}`;
  const lines: string[] = [];
  lines.push(`=== ${slug}: ${beforeTag} → ${afterTag} ===`);
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
      .map((s) => `  ${s.timestamp}  ${s.tag.padEnd(30)} cov=${s.coverage_score}  facts=${JSON.stringify(s.facts_in_yaml)}`)
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
  const snap = takeSnapshot(slug, tag);
  return {
    output: `Snapshot saved for ${slug} [${tag}]:
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
`,
    exitCode: 0,
  };
}

export const commands = { default: run, help };
export const getHelp = () => help().output;
