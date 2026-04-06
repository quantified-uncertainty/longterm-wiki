/**
 * Validate SourceCheckDot never appears as the first column in a table.
 *
 * Checks two patterns:
 * 1. HTML tables: SourceCheckDot inside the first <td> of a <tr>
 * 2. TanStack columns: a column definition containing SourceCheckDot that
 *    appears before the first column with accessorKey "name" or "title"
 *
 * Run: npx tsx crux/validate/validate-dot-position.ts
 */
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";

interface Violation {
  file: string;
  line: number;
  reason: string;
}

function collectTsx(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "__tests__") {
          walk(join(d, entry.name));
        }
      } else if (entry.name.endsWith(".tsx")) {
        results.push(join(d, entry.name));
      }
    }
  }
  walk(dir);
  return results;
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, "utf-8");
  if (!content.includes("SourceCheckDot")) return [];

  const lines = content.split("\n");
  const violations: Violation[] = [];
  const rel = relative(PROJECT_ROOT, filePath);

  // Pattern 1: HTML tables — check if first <td> in any <tr> contains SourceCheckDot
  let inTr = false;
  let inFirstTd = false;
  let firstTdDone = false;
  let tdStartLine = -1;
  let tdBuffer = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/<tr[\s>]/.test(line)) {
      inTr = true;
      firstTdDone = false;
    }
    if (inTr && !firstTdDone && !inFirstTd && line.includes("<td")) {
      inFirstTd = true;
      tdStartLine = i;
      tdBuffer = line;
    } else if (inFirstTd) {
      tdBuffer += "\n" + line;
    }
    if (inFirstTd && line.includes("</td")) {
      if (tdBuffer.includes("SourceCheckDot")) {
        violations.push({
          file: rel,
          line: tdStartLine + 1,
          reason: "SourceCheckDot in first <td> of table row",
        });
      }
      inFirstTd = false;
      firstTdDone = true;
      tdBuffer = "";
    }
    if (line.includes("</tr")) {
      inTr = false;
      inFirstTd = false;
      firstTdDone = false;
      tdBuffer = "";
    }
  }

  // Pattern 2: TanStack column arrays — SourceCheckDot column defined before name/title column.
  // Only match inside column definition objects (look for `cell:` context, not import lines).
  // A column def containing SourceCheckDot: line has SourceCheckDot AND is preceded by `id:` or `cell:` nearby.
  let sourceCheckColLine = -1;
  let nameColLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip import lines
    if (/^\s*import\s/.test(line)) continue;

    // Find the first column cell/id that references SourceCheckDot
    if (sourceCheckColLine === -1 && line.includes("SourceCheckDot") && !line.includes("import")) {
      // Verify it's inside a column definition by checking surrounding lines for column-like patterns
      const context = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
      if (/(?:cell:|id:|header:)/.test(context)) {
        sourceCheckColLine = i;
      }
    }

    // Find column with name/title accessor
    if (nameColLine === -1 && /accessorKey:\s*["'](name|title)["']/.test(line)) {
      nameColLine = i;
    }
  }

  if (sourceCheckColLine !== -1 && nameColLine !== -1 && sourceCheckColLine < nameColLine) {
    violations.push({
      file: rel,
      line: sourceCheckColLine + 1,
      reason: "SourceCheckDot column defined before name/title column in TanStack table",
    });
  }

  return violations;
}

export function runCheck() {
  const dirs = [
    join(PROJECT_ROOT, "apps/web/src/app"),
    join(PROJECT_ROOT, "apps/web/src/components"),
  ];
  const allFiles = dirs.flatMap(collectTsx);
  const violations = allFiles.flatMap(checkFile);

  if (violations.length === 0) {
    console.log("SourceCheckDot position check passed");
  } else {
    console.error(`SourceCheckDot position violations (${violations.length}):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — ${v.reason}`);
    }
  }

  return { passed: violations.length === 0, errors: violations.length, violations };
}

if (process.argv[1]?.includes("validate-dot-position")) {
  process.exit(runCheck().passed ? 0 : 1);
}
