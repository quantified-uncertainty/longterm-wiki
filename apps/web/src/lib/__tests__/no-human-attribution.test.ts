/**
 * Source code scan: no false human attribution.
 *
 * This wiki's quality ratings, grades, and content are all LLM-generated.
 * This test ensures source code doesn't incorrectly attribute that work
 * to humans (e.g., "Human-assigned rating" in a tooltip).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const APP_SRC_DIR = path.resolve(__dirname, "../..");

/** Recursively find files matching given extensions */
function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...findFiles(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

// Patterns that falsely attribute LLM work to humans.
// These are narrow to avoid false positives — "human-written" and
// "human-generated" are intentionally excluded as they often refer
// to external content (Wikipedia, training data, etc.).
const FORBIDDEN_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /human[- ]assigned/gi, label: "human-assigned" },
  { re: /human[- ]rated/gi, label: "human-rated" },
  { re: /human[- ]graded/gi, label: "human-graded" },
];

describe("no-human-attribution", () => {
  it("source code does not falsely attribute LLM work to humans", () => {
    const files = findFiles(APP_SRC_DIR, [".ts", ".tsx"]);
    const violations: { file: string; line: number; match: string }[] = [];

    for (const filePath of files) {
      // Skip this test file itself
      if (filePath.includes("no-human-attribution.test")) continue;

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comment-only lines that reference the pattern for documentation
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

        for (const { re, label } of FORBIDDEN_PATTERNS) {
          re.lastIndex = 0;
          let match;
          while ((match = re.exec(line)) !== null) {
            violations.push({
              file: path.relative(APP_SRC_DIR, filePath),
              line: i + 1,
              match: `${label}: "${match[0]}"`,
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${v.file}:${v.line} — ${v.match}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} false human attribution(s) in source code:\n${details}\n\n` +
          `This wiki's quality ratings and grades are LLM-generated. ` +
          `Use "LLM-assigned", "LLM-rated", or "LLM-graded" instead.`,
      );
    }
  });
});
