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

import { readFileSync } from "node:fs";
import { parseCliArgs } from "../lib/cli.ts";
import { gitSafe, isValidBranchName } from "../lib/git.ts";
import { detectNarrowPatches, formatFindings } from "./narrow-patch-detector.ts";

interface Options {
  base: string;
  stdin: boolean;
  json: boolean;
}

function resolveOptions(argv: string[]): Options {
  const parsed = parseCliArgs(argv);
  return {
    base: typeof parsed.base === "string" ? parsed.base : "main",
    stdin: parsed.stdin === true,
    json: parsed.json === true,
  };
}

function readDiff(opts: Options): string {
  if (opts.stdin) {
    return readFileSync(0, "utf8");
  }
  if (!isValidBranchName(opts.base)) {
    console.error(`detect-narrow-patch: invalid --base value "${opts.base}"`);
    process.exit(0); // advisory — never block
  }
  const result = gitSafe("diff", `${opts.base}...HEAD`);
  if (!result.ok) {
    console.error(`detect-narrow-patch: git diff failed: ${result.stderr}`);
    process.exit(0); // advisory — never block
  }
  return result.output;
}

function main(): void {
  const opts = resolveOptions(process.argv.slice(2));
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
