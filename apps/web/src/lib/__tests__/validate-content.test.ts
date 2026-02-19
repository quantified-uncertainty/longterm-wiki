/**
 * MDX content validation tests.
 *
 * Validates real MDX files for escaping, formatting, and content quality issues
 * that cause build failures or rendering bugs. Rules ported from the longterm
 * app's validation system (apps/longterm/scripts/lib/rules/).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Find and pre-read all MDX files
// ---------------------------------------------------------------------------

const CONTENT_DIR = path.resolve(
  __dirname,
  "../../../../../content/docs",
);

/** Recursively find files matching an extension */
function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(path.relative(CONTENT_DIR, fullPath));
    }
  }
  return results;
}

interface ParsedFile {
  file: string;
  lines: string[];
  bodyStart: number;
  /** Per-line boolean: true if the line is inside a code/Mermaid block */
  inCodeBlock: boolean[];
}

/** Pre-read and parse all MDX files once for all rules */
function loadAllFiles(): ParsedFile[] {
  const mdxFiles = findFiles(CONTENT_DIR, ".mdx");
  return mdxFiles.map((file) => {
    const content = fs.readFileSync(path.join(CONTENT_DIR, file), "utf-8");
    const lines = content.split("\n");
    const bodyStart = getBodyStartLine(lines);
    const inCodeBlock = computeCodeBlockMap(lines);
    return { file, lines, bodyStart, inCodeBlock };
  });
}

/** Split frontmatter from body. Returns the line index where body starts. */
function getBodyStartLine(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return i + 1;
  }
  return 0;
}

/**
 * Pre-compute a boolean array: inCodeBlock[i] is true if line i is inside
 * a fenced code block (``` ... ```) or a <MermaidDiagram> component.
 */
function computeCodeBlockMap(lines: string[]): boolean[] {
  const result: boolean[] = new Array(lines.length);
  let fenceOpen = false;
  let mermaidOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^```/.test(trimmed)) {
      fenceOpen = !fenceOpen;
    }
    if (/<Mermaid(?:Diagram)?[\s>]/.test(trimmed)) {
      mermaidOpen = true;
    }
    if (/<\/Mermaid(?:Diagram)?>/.test(trimmed)) {
      mermaidOpen = false;
    }
    result[i] = fenceOpen || mermaidOpen;
  }
  return result;
}

/** Check if a character position is inside inline code on the same line */
function isInInlineCode(line: string, charIndex: number): boolean {
  let count = 0;
  for (let i = 0; i < charIndex; i++) {
    if (line[i] === "`") count++;
  }
  return count % 2 === 1;
}

/** Check if a file path is an internal documentation page */
function isInternalPage(filePath: string): boolean {
  return filePath.startsWith("internal/") || filePath.startsWith("internal\\");
}

interface Violation {
  file: string;
  line: number;
  message: string;
}

function formatViolations(ruleName: string, violations: Violation[]): string {
  if (violations.length === 0) return "";
  const limit = 30;
  const shown = violations.slice(0, limit);
  const lines = shown.map((v) => `  ${v.file}:${v.line} — ${v.message}`);
  if (violations.length > limit) {
    lines.push(`  ... and ${violations.length - limit} more`);
  }
  return `${ruleName}: ${violations.length} violation(s)\n${lines.join("\n")}`;
}

// Pre-read all files once (outside test blocks, at module load time)
const allFiles = loadAllFiles();

// ---------------------------------------------------------------------------
// Rule 1: Dollar Signs
// ---------------------------------------------------------------------------

describe("dollar-signs", () => {
  it("no unescaped $ before digits in MDX body", () => {
    const violations: Violation[] = [];
    for (const { file, lines, bodyStart, inCodeBlock } of allFiles) {
      for (let i = bodyStart; i < lines.length; i++) {
        if (inCodeBlock[i]) continue;
        const line = lines[i];
        const pattern = /(?<!\\)\$(\d)/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          if (isInInlineCode(line, match.index)) continue;
          violations.push({
            file,
            line: i + 1,
            message: `Unescaped "$${match[1]}" — use "\\$${match[1]}" to prevent LaTeX parsing`,
          });
        }
      }
    }
    expect(
      violations,
      formatViolations("Unescaped dollar signs", violations),
    ).toHaveLength(0);
  });

  it("no double-escaped \\\\$ in MDX body", () => {
    const violations: Violation[] = [];
    for (const { file, lines, bodyStart, inCodeBlock } of allFiles) {
      for (let i = bodyStart; i < lines.length; i++) {
        if (inCodeBlock[i]) continue;
        const line = lines[i];
        const pattern = /\\\\\$/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          if (isInInlineCode(line, match.index)) continue;
          violations.push({
            file,
            line: i + 1,
            message: `Double-escaped "\\\\$" — use "\\$" instead`,
          });
        }
      }
    }
    expect(
      violations,
      formatViolations("Double-escaped dollar signs", violations),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: Comparison Operators
// ---------------------------------------------------------------------------

describe("comparison-operators", () => {
  it("no bare < before digits or $ (JSX parsing hazard)", () => {
    const violations: Violation[] = [];
    for (const { file, lines, bodyStart, inCodeBlock } of allFiles) {
      for (let i = bodyStart; i < lines.length; i++) {
        if (inCodeBlock[i]) continue;
        const line = lines[i];
        const pattern = /<(\d|\\?\$)/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          if (isInInlineCode(line, match.index)) continue;
          // Skip if already escaped as &lt;
          if (match.index >= 3 && line.substring(match.index - 3, match.index) === "&lt") continue;
          // Skip if preceded by backslash
          if (match.index > 0 && line[match.index - 1] === "\\") continue;
          // Skip valid HTML/JSX tags — < followed by a letter or /
          if (/^<[a-zA-Z/]/.test(line.substring(match.index))) continue;
          violations.push({
            file,
            line: i + 1,
            message: `Bare "<${match[1]}" — use "&lt;${match[1]}" to prevent JSX parsing errors`,
          });
        }
      }
    }
    expect(
      violations,
      formatViolations("Comparison operators", violations),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: Tilde-Dollar
// ---------------------------------------------------------------------------

describe("tilde-dollar", () => {
  it("no ~\\$ patterns (LaTeX rendering issue)", () => {
    const violations: Violation[] = [];
    for (const { file, lines, bodyStart, inCodeBlock } of allFiles) {
      for (let i = bodyStart; i < lines.length; i++) {
        if (inCodeBlock[i]) continue;
        const line = lines[i];
        const pattern = /~\\\$/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          if (isInInlineCode(line, match.index)) continue;
          violations.push({
            file,
            line: i + 1,
            message: `"~\\$" renders incorrectly — use "≈\\$" (Unicode approximately symbol) instead`,
          });
        }
      }
    }
    expect(
      violations,
      formatViolations("Tilde-dollar patterns", violations),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: Placeholders
// ---------------------------------------------------------------------------

describe("placeholders", () => {
  it("no TODO/FIXME/lorem ipsum in content pages", () => {
    const violations: Violation[] = [];
    const patterns: { re: RegExp; label: string }[] = [
      { re: /\bTODO\b/g, label: "TODO" },
      // Match FIXME only when not in quotes (quoted FIXME is often referencing a literal category)
      { re: /(?<!")FIXME(?!")/g, label: "FIXME" },
      { re: /Lorem ipsum/gi, label: "Lorem ipsum" },
      {
        re: /\[(?:Value|TODO|TBC|XX+)\]/gi,
        label: "bracketed placeholder",
      },
      { re: /\[Your [^\]]+\]/gi, label: "template prompt" },
    ];

    for (const { file, lines, bodyStart, inCodeBlock } of allFiles) {
      if (isInternalPage(file)) continue;

      for (let i = bodyStart; i < lines.length; i++) {
        if (inCodeBlock[i]) continue;
        const line = lines[i];

        for (const { re, label } of patterns) {
          re.lastIndex = 0;
          let match;
          while ((match = re.exec(line)) !== null) {
            if (isInInlineCode(line, match.index)) continue;
            // Skip HTML comments
            if (line.includes("<!--") && line.includes("-->")) continue;
            violations.push({
              file,
              line: i + 1,
              message: `${label}: "${match[0]}"`,
            });
          }
        }
      }
    }
    expect(
      violations,
      formatViolations("Placeholder content", violations),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Fake URLs
// ---------------------------------------------------------------------------

describe("fake-urls", () => {
  it("no example.com, localhost, or placeholder URLs in content", () => {
    const violations: Violation[] = [];
    const patterns: { re: RegExp; label: string }[] = [
      {
        re: /https?:\/\/(?:www\.)?example\.(?:com|org|net)(?:\/[^\s)"'\]]*)?/gi,
        label: "example.com",
      },
      {
        re: /https?:\/\/(?:www\.)?(?:placeholder|test|fake|dummy|sample)\.(?:com|org|net)(?:\/[^\s)"'\]]*)?/gi,
        label: "placeholder domain",
      },
      {
        re: /https?:\/\/(?:www\.)?(?:foo|bar|baz|qux)\.(?:com|org|net)(?:\/[^\s)"'\]]*)?/gi,
        label: "foo/bar domain",
      },
      {
        re: /https?:\/\/localhost(?::\d+)?(?:\/[^\s)"'\]]*)?/gi,
        label: "localhost",
      },
      {
        re: /https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/[^\s)"'\]]*)?/gi,
        label: "127.0.0.1",
      },
      {
        re: /https?:\/\/(?:www\.)?(?:your(?:site|domain|company|blog|website)|mysite|mydomain)\.(?:com|org|net)(?:\/[^\s)"'\]]*)?/gi,
        label: "yoursite placeholder",
      },
    ];

    for (const { file, lines, bodyStart, inCodeBlock } of allFiles) {
      if (isInternalPage(file)) continue;

      for (let i = bodyStart; i < lines.length; i++) {
        if (inCodeBlock[i]) continue;
        const line = lines[i];
        // Skip blockquotes — example.com is often used in illustrative scenarios
        if (/^\s*>/.test(line)) continue;

        for (const { re, label } of patterns) {
          re.lastIndex = 0;
          let match;
          while ((match = re.exec(line)) !== null) {
            if (isInInlineCode(line, match.index)) continue;
            violations.push({
              file,
              line: i + 1,
              message: `Fake URL (${label}): "${match[0]}"`,
            });
          }
        }
      }
    }
    expect(
      violations,
      formatViolations("Fake URLs", violations),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 6: Markdown Lists
// ---------------------------------------------------------------------------

describe("markdown-lists", () => {
  it("numbered lists starting >1 have a preceding blank line", () => {
    const violations: Violation[] = [];
    const numberedListPattern = /^(\d+)\.\s+/;

    for (const { file, lines, bodyStart, inCodeBlock } of allFiles) {
      for (let i = bodyStart; i < lines.length; i++) {
        if (inCodeBlock[i]) continue;
        const match = lines[i].match(numberedListPattern);
        if (!match) continue;

        const num = parseInt(match[1], 10);
        if (num <= 1) continue;

        // Check if previous line is blank or is itself a list item
        if (i > 0) {
          const prevLine = lines[i - 1].trim();
          const isPrevBlank = prevLine === "";
          const isPrevListItem = /^\d+\.\s+/.test(prevLine);
          const isPrevBullet = /^[-*+]\s+/.test(prevLine);
          if (!isPrevBlank && !isPrevListItem && !isPrevBullet) {
            violations.push({
              file,
              line: i + 1,
              message: `Numbered list starts at ${num} without a blank line before it — this may not render as a list`,
            });
          }
        }
      }
    }
    expect(
      violations,
      formatViolations("Markdown list formatting", violations),
    ).toHaveLength(0);
  });
});
