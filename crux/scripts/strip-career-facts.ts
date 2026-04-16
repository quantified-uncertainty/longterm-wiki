/**
 * Surgically removes employed-by and role fact blocks from FactBase YAML files
 * WITHOUT reformatting. Preserves original YAML style, blank lines, etc.
 *
 * Usage: node --import tsx/esm crux/scripts/strip-career-facts-v2.ts [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const THINGS_DIR = join(ROOT, "packages/factbase/data/fb-entities");
const dryRun = process.argv.includes("--dry-run");

let filesModified = 0;
let factsRemoved = 0;

for (const filename of readdirSync(THINGS_DIR).filter((f) => f.endsWith(".yaml"))) {
  const filePath = join(THINGS_DIR, filename);
  const content = readFileSync(filePath, "utf-8");

  // Check if file has any career facts
  if (!/property:\s*"?(?:employed-by|role)"?/.test(content)) continue;

  const lines = content.split("\n");
  const outputLines: string[] = [];
  let inCareerFact = false;
  let removedInThisFile = 0;
  let blankLineBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect start of a fact block (indented "- id:")
    if (/^\s{2}- id:/.test(line)) {
      // Look ahead to find the property line
      let propLine = "";
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (/^\s+property:/.test(lines[j])) {
          propLine = lines[j];
          break;
        }
      }

      const isCareerFact = /property:\s*"?(?:employed-by|role)"?/.test(propLine);
      if (isCareerFact) {
        inCareerFact = true;
        removedInThisFile++;
        factsRemoved++;
        blankLineBuffer = []; // Drop buffered blank lines before this fact
        continue;
      } else {
        inCareerFact = false;
        // Flush blank line buffer
        outputLines.push(...blankLineBuffer);
        blankLineBuffer = [];
        outputLines.push(line);
        continue;
      }
    }

    if (inCareerFact) {
      // Skip lines belonging to the current career fact block
      // A fact block ends when we hit another "  - id:" or a non-indented line
      if (/^\s{2}- id:/.test(line) || /^[^\s]/.test(line)) {
        inCareerFact = false;
        // Re-process this line
        i--;
        continue;
      }
      // Blank line within a career fact block — skip
      if (line.trim() === "") continue;
      // Still in the career fact — skip
      continue;
    }

    // Buffer blank lines (we might drop them if followed by a career fact)
    if (line.trim() === "" && outputLines.length > 0) {
      blankLineBuffer.push(line);
      continue;
    }

    // Normal line — flush buffer and keep
    outputLines.push(...blankLineBuffer);
    blankLineBuffer = [];
    outputLines.push(line);
  }

  // Flush remaining buffer
  outputLines.push(...blankLineBuffer);

  if (removedInThisFile === 0) continue;

  // Clean up trailing blank lines before EOF
  let result = outputLines.join("\n");
  result = result.replace(/\n{3,}/g, "\n\n"); // Collapse multiple blank lines
  if (!result.endsWith("\n")) result += "\n";

  if (dryRun) {
    console.log(`[DRY RUN] ${filename}: remove ${removedInThisFile} career facts`);
  } else {
    writeFileSync(filePath, result);
  }
  filesModified++;
}

console.log(`\nFiles modified: ${filesModified}`);
console.log(`Career facts removed: ${factsRemoved}`);
if (dryRun) console.log("[DRY RUN] No files were modified.");
