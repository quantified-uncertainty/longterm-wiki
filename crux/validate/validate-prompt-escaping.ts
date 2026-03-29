#!/usr/bin/env node

/**
 * Validate that LLM prompt-building functions escape interpolated values in XML tags.
 *
 * Scans all .ts files under crux/ for functions whose names contain "prompt" (case-insensitive),
 * then checks template literals for patterns like `<tag>${expr}</tag>` where `expr` does NOT
 * contain `escapeXml(`. This is a heuristic to catch the most common prompt injection vector.
 *
 * Excluded:
 *   - Test files (__tests__/, *.test.ts)
 *   - node_modules/
 *
 * Suppression: add `// prompt-escape-ok` on the same line as the interpolation.
 *
 * Usage: npx tsx crux/validate/validate-prompt-escaping.ts
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

/** Directory to scan (relative to PROJECT_ROOT) */
const SCAN_DIR = 'crux';

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** Recursively collect .ts files, excluding tests and node_modules */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(fullPath);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Match function declarations/expressions whose name contains "prompt" (case-insensitive).
 * Captures everything from the function signature to its closing brace.
 *
 * We use a simple brace-counting approach to extract function bodies, then scan
 * template literals within those bodies for unescaped XML interpolations.
 */

/** Pattern for XML-tag-wrapped interpolation: <tag>${...}</tag> */
// Matches: <some_tag>${...}</some_tag> on a single source line
// Group 1: the interpolated expression between ${ and }
const XML_INTERP_PATTERN = /<\w[\w-]*>\$\{([^}]+)\}<\/\w[\w-]*>/g;

/** Suppression comment */
const SUPPRESS_COMMENT = 'prompt-escape-ok';

/** Patterns that match function declarations with "prompt" in the name. Exported for testing. */
export const PROMPT_FUNC_PATTERNS = [
  // function buildPrompt(...) {
  /\bfunction\s+\w*[Pp]rompt\w*\s*\(/,
  // const buildPrompt = (...) => {
  /\b(?:const|let|var)\s+\w*[Pp]rompt\w*\s*=/,
  // buildPrompt(...) {  (method definition)
  /\b\w*[Pp]rompt\w*\s*\([^)]*\)\s*(?::\s*\w[^{]*)?\{/,
  // Also match case-insensitive "prompt" in function names more broadly
  /\bfunction\s+\w*prompt\w*\s*\(/i,
  /\b(?:const|let|var)\s+\w*prompt\w*\s*=/i,
];

/**
 * Check a single line inside a prompt function for unescaped XML interpolations.
 * Returns violations found on that line. Exported for testing.
 */
export function checkPromptLine(line: string): Array<{ expr: string }> {
  const trimmed = line.trimStart();

  // Skip if suppressed
  if (line.includes(SUPPRESS_COMMENT)) return [];

  // Skip comment lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return [];
  }

  const violations: Array<{ expr: string }> = [];
  let match: RegExpExecArray | null;
  XML_INTERP_PATTERN.lastIndex = 0;
  while ((match = XML_INTERP_PATTERN.exec(line)) !== null) {
    const expr = match[1];
    if (expr.includes('escapeXml(')) continue;
    violations.push({ expr });
  }
  return violations;
}

/**
 * Check whether a line index falls inside a prompt-building function.
 *
 * We identify prompt functions by scanning for function/method/arrow definitions
 * whose name contains "prompt" (case-insensitive), then track their brace-delimited bodies.
 */
function findPromptFunctionRanges(lines: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  const promptFuncPatterns = PROMPT_FUNC_PATTERNS;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    const isPromptFunc = promptFuncPatterns.some((p) => p.test(trimmed));
    if (!isPromptFunc) continue;

    // Find the opening brace for this function
    let braceCount = 0;
    let foundOpen = false;
    let startLine = i;
    let endLine = i;

    for (let j = i; j < lines.length; j++) {
      const chars = lines[j];
      for (const ch of chars) {
        if (ch === '{') {
          braceCount++;
          foundOpen = true;
        } else if (ch === '}') {
          braceCount--;
        }
      }
      if (foundOpen && braceCount <= 0) {
        endLine = j;
        break;
      }
      // Safety: don't scan more than 500 lines for a single function
      if (j - i > 500) {
        endLine = j;
        break;
      }
    }

    ranges.push({ start: startLine, end: endLine });
  }

  return ranges;
}

function checkFile(filePath: string): Violation[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];
  const relPath = relative(PROJECT_ROOT, filePath);

  const promptRanges = findPromptFunctionRanges(lines);
  if (promptRanges.length === 0) return [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line is inside a prompt function
    const inPromptFunc = promptRanges.some((r) => i >= r.start && i <= r.end);
    if (!inPromptFunc) continue;

    // Skip if suppressed
    if (line.includes(SUPPRESS_COMMENT)) continue;

    // Skip comment lines
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    // Check for XML-tag-wrapped interpolations
    let match: RegExpExecArray | null;
    XML_INTERP_PATTERN.lastIndex = 0;
    while ((match = XML_INTERP_PATTERN.exec(line)) !== null) {
      const expr = match[1];
      // Allow if the expression contains escapeXml(
      if (expr.includes('escapeXml(')) continue;

      violations.push({
        file: relPath,
        line: i + 1,
        text: trimmed,
      });
    }
  }

  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: Violation[] } {
  const c = getColors();
  console.log(`${c.blue}Checking for unescaped interpolations in LLM prompt XML tags...${c.reset}\n`);

  const absDir = join(PROJECT_ROOT, SCAN_DIR);
  const allFiles = collectTsFiles(absDir);

  if (allFiles.length === 0) {
    console.log(`${c.dim}No files found to check${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const allViolations: Violation[] = [];

  for (const file of allFiles) {
    const violations = checkFile(file);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log(`${c.green}No unescaped prompt interpolations found (${allFiles.length} files checked)${c.reset}`);
  } else {
    console.log(`${c.red}Found ${allViolations.length} unescaped prompt interpolation(s):${c.reset}\n`);
    for (const v of allViolations) {
      console.log(`  ${c.red}${v.file}:${v.line}${c.reset}`);
      console.log(`    ${c.dim}${v.text}${c.reset}`);
      console.log(`    ${c.dim}Fix: wrap the interpolated value with escapeXml(), or add // prompt-escape-ok${c.reset}\n`);
    }
  }

  return { passed: allViolations.length === 0, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-prompt-escaping')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
