/**
 * Populate sourceResource field in KB YAML files from source URLs.
 *
 * For each fact that has a `source:` URL but no `sourceResource:`,
 * looks up the resource by URL in the local YAML resource registry and
 * inserts a `sourceResource: <id>` line after the source line.
 *
 * Uses line-level text insertion to preserve YAML formatting, comments,
 * custom tags (!ref, !date), and scientific notation (100e6).
 *
 * Usage:
 *   npx tsx packages/kb/scripts/populate-source-resources.ts [--dry-run] [--entity=slug]
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

import { getResourceByUrl } from "../../../crux/lib/search/resource-lookup.ts";

const KB_DATA_DIR = join(import.meta.dirname, "../data");
const THINGS_DIR = join(KB_DATA_DIR, "things");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const entityArg = args.find((a) => a.startsWith("--entity="))?.split("=")[1];

interface Stats {
  filesScanned: number;
  factsWithSource: number;
  alreadyHasResource: number;
  matched: number;
  unmatched: number;
  filesModified: number;
}

function main(): void {
  const stats: Stats = {
    filesScanned: 0,
    factsWithSource: 0,
    alreadyHasResource: 0,
    matched: 0,
    unmatched: 0,
    filesModified: 0,
  };

  const files = readdirSync(THINGS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .filter((f) => !entityArg || f === `${entityArg}.yaml`);

  for (const file of files) {
    const filePath = join(THINGS_DIR, file);
    const content = readFileSync(filePath, "utf-8");
    stats.filesScanned++;

    const lines = content.split("\n");
    const outputLines: string[] = [];
    let fileModified = false;

    for (let i = 0; i < lines.length; i++) {
      outputLines.push(lines[i]);

      // Match a `source:` line (indented, within a fact block)
      const sourceMatch = lines[i].match(/^(\s+)source:\s+(.+?)\s*$/);
      if (!sourceMatch) continue;

      const indent = sourceMatch[1];
      const sourceUrl = sourceMatch[2]
        .replace(/\s+#.*$/, "")       // strip inline comments
        .replace(/^['"]|['"]$/g, ""); // strip surrounding quotes

      // Skip if this fact block already has sourceResource (scan forward)
      let alreadyHasSourceResource = false;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (!line.trim()) continue; // skip blank lines

        const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (currentIndent < indent.length) break; // left the fact block

        if (line.trim().startsWith("sourceResource:")) {
          alreadyHasSourceResource = true;
          break;
        }
      }

      if (alreadyHasSourceResource) {
        stats.alreadyHasResource++;
        stats.factsWithSource++;
        continue;
      }

      // Skip non-URL sources (e.g., plain text notes)
      if (!sourceUrl.startsWith("http")) continue;

      stats.factsWithSource++;

      const resource = getResourceByUrl(sourceUrl);
      if (resource) {
        stats.matched++;
        const entityId = file.replace(".yaml", "");
        if (dryRun) {
          console.log(
            `  ${entityId}: ${resource.id} ← ${sourceUrl.slice(0, 70)}`
          );
        } else {
          // Insert sourceResource line after the source line, same indentation
          outputLines.push(`${indent}sourceResource: ${resource.id}`);
          fileModified = true;
        }
      } else {
        stats.unmatched++;
      }
    }

    if (fileModified && !dryRun) {
      writeFileSync(filePath, outputLines.join("\n"));
      stats.filesModified++;
    }
  }

  console.log("\n--- Results ---");
  console.log(`Files scanned:          ${stats.filesScanned}`);
  console.log(`Facts with source URL:  ${stats.factsWithSource}`);
  console.log(`Already has resource:   ${stats.alreadyHasResource}`);
  console.log(`Matched to resource:    ${stats.matched}`);
  console.log(`No matching resource:   ${stats.unmatched}`);
  if (!dryRun) {
    console.log(`Files modified:         ${stats.filesModified}`);
  } else {
    console.log("(dry run — no files modified)");
  }
}

main();
