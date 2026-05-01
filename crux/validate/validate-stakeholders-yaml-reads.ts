#!/usr/bin/env node

/**
 * Policy-stakeholders YAML-read validator (QUA-960 step 8 / R-B6).
 *
 * Bans new code paths that read `entity.stakeholders` from YAML loaders or
 * directly parse `stakeholders:` blocks out of `data/entities/responses.yaml`.
 * Once QUA-960 cuts over, PG is the authoritative source — every YAML reader
 * needs to migrate to `fetchPolicyStakeholdersFromPG()` (or equivalent).
 *
 * The current baseline of files with YAML stakeholder reads is recorded in
 * `crux/validate/.stakeholders-yaml-reads-allowlist.txt`. The allowlist
 * length is the QUA-960 closure metric — it shrinks to zero as the cutover
 * PR replaces each consumer.
 *
 * **Advisory in the prep PR (QUA-960 step 8 / Prep half).** Blocking once
 * the cutover PR replaces the consumers and the allowlist is empty.
 *
 * Suppression: add `// stakeholders-yaml-ok: <reason>` on the same line.
 *
 * Usage:
 *   npx tsx crux/validate/validate-stakeholders-yaml-reads.ts            # check
 *   npx tsx crux/validate/validate-stakeholders-yaml-reads.ts --update   # rewrite allowlist
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";
import {
  buildSuppressionRegex,
  findInlineCommentStart,
  isInsideStringAt,
} from "./lib/comment-utils.ts";
import { collectTsFiles } from "./lib/file-walker.ts";

const SCAN_DIRS = [
  join(PROJECT_ROOT, "crux/commands"),
  join(PROJECT_ROOT, "crux/lib"),
  join(PROJECT_ROOT, "crux/scripts"),
  join(PROJECT_ROOT, "apps/web/src/app"),
  join(PROJECT_ROOT, "apps/web/src/components"),
  join(PROJECT_ROOT, "apps/web/src/data"),
  join(PROJECT_ROOT, "apps/web/scripts"),
];
const ALLOWLIST_PATH = join(
  PROJECT_ROOT,
  "crux/validate/.stakeholders-yaml-reads-allowlist.txt",
);
const SUPPRESSION_MARKER = "stakeholders-yaml-ok";
const SUPPRESSION_REGEX = buildSuppressionRegex(SUPPRESSION_MARKER);

type Kind = "PROPERTY_READ" | "YAML_KEY";

const PATTERNS: Array<{ globalPattern: RegExp; kind: Kind }> = [
  // entity.stakeholders, e.stakeholders, policy.stakeholders, etc.
  { globalPattern: /\.stakeholders\b/g, kind: "PROPERTY_READ" },
  // entity["stakeholders"] / entity['stakeholders'] bracket-notation reads.
  { globalPattern: /\[\s*["']stakeholders["']\s*\]/g, kind: "PROPERTY_READ" },
  // Top-level YAML key access via parseYaml / readFileSync chains. We don't
  // try to AST-parse — flag any literal `stakeholders?:` field type or
  // `'stakeholders'` quoted key in code under the scan dirs.
  { globalPattern: /\bstakeholders\?:\s/g, kind: "YAML_KEY" },
];

export interface Violation {
  line: number;
  text: string;
  kind: Kind;
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function lineIsSuppressed(line: string): boolean {
  if (!line.includes(SUPPRESSION_MARKER)) return false;
  const commentStart = findInlineCommentStart(line);
  if (commentStart === -1) return false;
  return SUPPRESSION_REGEX.test(line.slice(commentStart + 2));
}

export function checkLine(line: string): Kind | null {
  if (isCommentLine(line.trimStart())) return null;
  if (lineIsSuppressed(line)) return null;
  const commentStart = findInlineCommentStart(line);
  for (const { globalPattern, kind } of PATTERNS) {
    for (const match of line.matchAll(globalPattern)) {
      const idx = match.index ?? 0;
      if (commentStart !== -1 && idx >= commentStart) continue;
      if (isInsideStringAt(line, idx)) continue;
      return kind;
    }
  }
  return null;
}

function checkFile(filePath: string, baseDir: string): { relPath: string; violations: Violation[] } {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Violation[] = [];
  const relPath = relative(baseDir, filePath);
  for (let i = 0; i < lines.length; i++) {
    const kind = checkLine(lines[i]);
    if (kind) {
      violations.push({ line: i + 1, text: lines[i].trimStart(), kind });
    }
  }
  return { relPath, violations };
}

export function readAllowlist(path: string = ALLOWLIST_PATH): Set<string> {
  const allowed = new Set<string>();
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return allowed;
  }
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    allowed.add(line);
  }
  return allowed;
}

interface CheckResult {
  passed: boolean;
  errors: number;
  newViolations: Array<Violation & { file: string }>;
  staleEntries: string[];
  allowlistedFileCount: number;
  fileCountWithReads: number;
}

export function runCheck(
  opts: { rootDirs?: string[]; allowlistPath?: string; baseDir?: string; updateBaseline?: boolean } = {},
): CheckResult {
  const c = getColors();
  const rootDirs = opts.rootDirs ?? SCAN_DIRS;
  const allowlistPath = opts.allowlistPath ?? ALLOWLIST_PATH;
  const baseDir = opts.baseDir ?? PROJECT_ROOT;

  console.log(`${c.blue}Checking YAML stakeholder reads (QUA-960)...${c.reset}\n`);

  const allFiles: string[] = [];
  for (const dir of rootDirs) {
    if (!existsSync(dir)) continue;
    allFiles.push(...collectTsFiles(dir, { includeTsx: true, includeMjs: true }));
  }

  const filesWithReads = new Map<string, Violation[]>();
  for (const file of allFiles) {
    const { relPath, violations } = checkFile(file, baseDir);
    if (violations.length > 0) filesWithReads.set(relPath, violations);
  }

  if (opts.updateBaseline) {
    const sorted = [...filesWithReads.keys()].sort();
    let existing: string;
    try {
      existing = readFileSync(allowlistPath, "utf-8");
    } catch {
      existing = "";
    }
    const headerLines: string[] = [];
    for (const line of existing.split("\n")) {
      if (line.startsWith("#") || line.trim() === "") {
        headerLines.push(line);
      } else {
        break;
      }
    }
    const header = headerLines.length > 0
      ? headerLines.join("\n").replace(/\n+$/, "") + "\n"
      : "";
    const body = sorted.join("\n") + "\n";
    writeFileSync(allowlistPath, header + body);
    console.log(`${c.green}Wrote ${sorted.length} entries to ${relative(baseDir, allowlistPath)}${c.reset}`);
    return {
      passed: true,
      errors: 0,
      newViolations: [],
      staleEntries: [],
      allowlistedFileCount: sorted.length,
      fileCountWithReads: sorted.length,
    };
  }

  const allowed = readAllowlist(allowlistPath);
  const newViolations: Array<Violation & { file: string }> = [];
  for (const [file, vs] of filesWithReads) {
    if (!allowed.has(file)) {
      for (const v of vs) newViolations.push({ ...v, file });
    }
  }

  const staleEntries: string[] = [];
  for (const entry of allowed) {
    if (!filesWithReads.has(entry)) staleEntries.push(entry);
  }

  const errors = newViolations.length + staleEntries.length;
  if (errors === 0) {
    console.log(
      `${c.green}No new YAML stakeholder reads outside allowlist (${filesWithReads.size} files allowlisted, ${allFiles.length} files scanned)${c.reset}`,
    );
    if (filesWithReads.size > 0) {
      console.log(
        `${c.dim}QUA-960 closure metric: ${filesWithReads.size} files still read stakeholders from YAML${c.reset}`,
      );
    }
  } else {
    if (newViolations.length > 0) {
      const fileCount = new Set(newViolations.map((v) => v.file)).size;
      console.log(
        `${c.red}Found ${newViolations.length} new YAML stakeholder read(s) in ${fileCount} non-allowlisted file(s):${c.reset}\n`,
      );
      for (const v of newViolations) {
        console.log(`  ${c.red}${v.file}:${v.line}${c.reset} [${v.kind}]`);
        console.log(`    ${c.dim}${v.text}${c.reset}`);
      }
      console.log(
        `\n${c.dim}Fix: read stakeholders via fetchPolicyStakeholdersFromPG() / GET /api/policy-stakeholders, not from YAML (QUA-960).${c.reset}`,
      );
      console.log(
        `${c.dim}Suppress a single legitimate use: add \`// ${SUPPRESSION_MARKER}: <reason>\` on the same line.${c.reset}`,
      );
    }
    if (staleEntries.length > 0) {
      console.log(
        `${c.yellow}${staleEntries.length} stale allowlist entr${
          staleEntries.length === 1 ? "y" : "ies"
        } (file no longer reads stakeholders from YAML — please remove):${c.reset}`,
      );
      for (const entry of staleEntries) console.log(`  ${c.yellow}${entry}${c.reset}`);
      console.log(
        `\n${c.dim}Update with: npx tsx crux/validate/validate-stakeholders-yaml-reads.ts --update${c.reset}\n`,
      );
    }
  }

  return {
    passed: errors === 0,
    errors,
    newViolations,
    staleEntries,
    allowlistedFileCount: allowed.size,
    fileCountWithReads: filesWithReads.size,
  };
}

const __isMain = process.argv[1]?.endsWith("validate-stakeholders-yaml-reads.ts");
if (__isMain) {
  const updateBaseline = process.argv.includes("--update");
  const result = runCheck({ updateBaseline });
  process.exit(result.passed ? 0 : 1);
}
