/**
 * Validate dot indicators never appear as the first column in a table.
 *
 * Detects both `SourceCheckDot` (direct) and `RecordStatusDots` (wrapper
 * that renders SourceCheckDot internally).
 *
 * Checks two patterns:
 * 1. HTML tables: dot component inside the first <td> of a <tr>
 * 2. TanStack columns: within each ColumnDef array, a column containing a
 *    dot component that appears before the first column with accessorKey
 *    "name" or "title"
 *
 * Run: npx tsx crux/validate/validate-dot-position.ts
 */
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";

/** Components that render status dots (SourceCheckDot or wrappers around it) */
const DOT_COMPONENTS = ["SourceCheckDot", "RecordStatusDots"];

function hasDotComponent(text: string): boolean {
  return DOT_COMPONENTS.some((c) => text.includes(c));
}

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
  if (!hasDotComponent(content)) return [];

  const lines = content.split("\n");
  const violations: Violation[] = [];
  const rel = relative(PROJECT_ROOT, filePath);

  // Pattern 1: HTML tables — check if first <td> in any <tr> contains a dot component
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
      if (hasDotComponent(tdBuffer)) {
        const which = DOT_COMPONENTS.find((c) => tdBuffer.includes(c));
        violations.push({
          file: rel,
          line: tdStartLine + 1,
          reason: `${which} in first <td> of table row`,
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

  // Pattern 2: TanStack column arrays — dot column defined before name/title column.
  //
  // Parse per-array: find each ColumnDef[] array (indicated by `: ColumnDef<` or
  // `satisfies ColumnDef<` or `as ColumnDef<`), then extract the column objects
  // within that array using brace-depth tracking. Check ordering within each array
  // independently so unrelated arrays or imports don't cause false positives.
  checkTanStackColumns(lines, rel, violations);

  return violations;
}

/**
 * Parse TanStack ColumnDef arrays and check that dot columns come after name/title columns.
 *
 * Strategy: find lines that start a ColumnDef array (type annotation followed by `[`),
 * then track brace/bracket depth to extract individual column objects. Within each
 * array, record whether a dot column appears before the first name/title column.
 */
function checkTanStackColumns(
  lines: string[],
  rel: string,
  violations: Violation[]
): void {
  // Find the start of each ColumnDef array declaration
  const arrayStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip import lines
    if (/^\s*import\s/.test(line)) continue;
    // Match patterns like: `: ColumnDef<Foo>[] = [`, `satisfies ColumnDef<Foo>[]`,
    // or a line with `ColumnDef<` followed by `[` on same or next line
    if (/ColumnDef</.test(line) && !/import/.test(line)) {
      // Find the opening `[` — could be on this line or the next
      const bracketIdx = line.indexOf("[", line.indexOf("ColumnDef"));
      if (bracketIdx !== -1) {
        arrayStarts.push(i);
      } else if (i + 1 < lines.length && lines[i + 1].trim().startsWith("[")) {
        arrayStarts.push(i + 1);
      }
    }
  }

  for (const startLine of arrayStarts) {
    checkSingleColumnArray(lines, startLine, rel, violations);
  }
}

/**
 * Check a single ColumnDef array starting at `startLine` for dot-before-name violations.
 */
function checkSingleColumnArray(
  lines: string[],
  startLine: number,
  rel: string,
  violations: Violation[]
): void {
  // Track bracket depth to find the end of the array
  let bracketDepth = 0;
  let braceDepth = 0;
  let started = false;
  let arrayEndLine = lines.length;

  // Track columns: each top-level object `{ ... }` in the array is one column
  let inColumn = false;
  let columnStartLine = -1;
  let columnBuffer = "";

  // Per-array tracking
  let firstDotColLine = -1;
  let firstNameColLine = -1;
  let dotComponentName = "";

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];

    for (const ch of line) {
      if (ch === "[") {
        bracketDepth++;
        started = true;
      }
      if (ch === "]") {
        bracketDepth--;
        if (started && bracketDepth === 0) {
          arrayEndLine = i;
        }
      }
      if (ch === "{") {
        braceDepth++;
        // A top-level object inside the array (bracketDepth === 1, braceDepth === 1)
        if (bracketDepth === 1 && braceDepth === 1 && !inColumn) {
          inColumn = true;
          columnStartLine = i;
          columnBuffer = "";
        }
      }
      if (ch === "}") {
        braceDepth--;
        if (bracketDepth === 1 && braceDepth === 0 && inColumn) {
          // End of a column definition object
          columnBuffer += "\n" + line;
          analyzeColumn(
            columnBuffer,
            columnStartLine,
            (line, name) => {
              if (firstDotColLine === -1) {
                firstDotColLine = line;
                dotComponentName = name;
              }
            },
            (line) => {
              if (firstNameColLine === -1) {
                firstNameColLine = line;
              }
            }
          );
          inColumn = false;
          columnBuffer = "";
          continue; // skip appending to buffer below
        }
      }
    }

    if (inColumn) {
      columnBuffer += "\n" + line;
    }

    if (i === arrayEndLine) break;
  }

  // Check: dot column before name/title column within this array
  if (
    firstDotColLine !== -1 &&
    firstNameColLine !== -1 &&
    firstDotColLine < firstNameColLine
  ) {
    violations.push({
      file: rel,
      line: firstDotColLine + 1,
      reason: `${dotComponentName} column defined before name/title column in TanStack table`,
    });
  }
}

/**
 * Analyze a single column definition buffer for dot components and name/title accessor.
 */
function analyzeColumn(
  buffer: string,
  startLine: number,
  onDot: (line: number, componentName: string) => void,
  onName: (line: number) => void
): void {
  // Check if this column renders a dot component (in cell, not in imports)
  for (const comp of DOT_COMPONENTS) {
    if (buffer.includes(comp)) {
      onDot(startLine, comp);
      break;
    }
  }
  // Check if this column has a name/title accessorKey
  if (/accessorKey:\s*["'](name|title)["']/.test(buffer)) {
    onName(startLine);
  }
}

export function runCheck() {
  const dirs = [
    join(PROJECT_ROOT, "apps/web/src/app"),
    join(PROJECT_ROOT, "apps/web/src/components"),
  ];
  const allFiles = dirs.flatMap(collectTsx);
  const violations = allFiles.flatMap(checkFile);

  if (violations.length === 0) {
    console.log("Dot-position check passed (SourceCheckDot / RecordStatusDots)");
  } else {
    console.error(`Dot-position violations (${violations.length}):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — ${v.reason}`);
    }
  }

  return { passed: violations.length === 0, errors: violations.length, violations };
}

if (process.argv[1]?.includes("validate-dot-position")) {
  process.exit(runCheck().passed ? 0 : 1);
}
