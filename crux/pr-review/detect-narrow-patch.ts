#!/usr/bin/env -S npx tsx
/**
 * CLI entry for the narrow-patch detector (QUA-356).
 *
 * Usage (from the repo root):
 *   npx tsx crux/pr-review/detect-narrow-patch.ts
 *
 * Reads `git diff <base>...HEAD` (default base: `main`), runs the detector,
 * and prints findings. Exits 0 always — this is an advisory hint, not a gate.
 * `/agent-review-pr` invokes it in Phase 3 alongside the hostile-reviewer
 * subagent.
 *
 * Options:
 *   --base=<ref>   Git base to diff against (default: main)
 *   --stdin        Read the diff from stdin instead of running git
 *   --json         Emit findings as JSON
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { detectNarrowPatches, formatFindings } from "./narrow-patch-detector.ts";

function parseArgs(argv: string[]): {
  base: string;
  stdin: boolean;
  json: boolean;
} {
  const args = { base: "main", stdin: false, json: false };
  for (const arg of argv) {
    if (arg === "--stdin") args.stdin = true;
    else if (arg === "--json") args.json = true;
    else if (arg.startsWith("--base=")) args.base = arg.slice("--base=".length);
  }
  return args;
}

function readDiff(opts: { base: string; stdin: boolean }): string {
  if (opts.stdin) {
    return readFileSync(0, "utf8");
  }
  try {
    return execSync(`git diff ${opts.base}...HEAD`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`detect-narrow-patch: failed to run git diff: ${msg}`);
    process.exit(0); // advisory — never block
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const diff = readDiff(opts);
  const findings = detectNarrowPatches(diff);

  if (opts.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    console.log(formatFindings(findings));
  }
  process.exit(0);
}

main();
