/**
 * Codebase cruft detection: TODOs, large files, commented-out code.
 */

import { execSync } from 'child_process';
import { PROJECT_ROOT } from '../content-types.ts';
import type { CruftItem } from './types.ts';

const EXEC_OPTS = { encoding: 'utf-8' as const, cwd: PROJECT_ROOT, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 };

/**
 * Find TODO/FIXME/HACK comments in source files.
 *
 * Uses a targeted grep that only matches actual code comments (// TODO, /* TODO, etc.)
 * rather than string literals or pattern-matching code. This avoids false positives from
 * format strings like "rc-XXXX", validator patterns that detect TODOs, and test fixtures.
 */
export function findTodoComments(): CruftItem[] {
  const items: CruftItem[] = [];
  try {
    // Match actual comments: // TODO, /* TODO, {/* TODO, /** TODO */, * TODO (JSDoc continuation)
    const todoOutput = execSync(
      `grep -rn '//\\s*TODO\\b\\|//\\s*FIXME\\b\\|//\\s*HACK\\b\\|/\\*\\+\\s*TODO\\b\\|/\\*\\+\\s*FIXME\\b\\|/\\*\\+\\s*HACK\\b\\|^\\s*\\*\\+\\s*TODO\\b\\|^\\s*\\*\\+\\s*FIXME\\b\\|^\\s*\\*\\+\\s*HACK\\b' crux/ apps/web/src/ --include='*.ts' --include='*.tsx' --include='*.mjs' 2>/dev/null || true`,
      EXEC_OPTS
    );
    for (const line of todoOutput.split('\n').filter(Boolean)) {
      const match = line.match(/^([^:]+):(\d+):(.+)$/);
      if (match) {
        // Skip test files, this file itself, and scaffold/template generators
        // (their TODOs are intentional template markers emitted into generated code).
        if (
          match[1].includes('.test.') ||
          match[1].includes('cruft-detection.ts') ||
          /-scaffold\.ts$|\/scaffold\.ts$/.test(match[1])
        ) continue;
        // Skip comments that already have an issue number (#NNNN)
        if (/#\d+\b/.test(match[3])) continue;
        items.push({
          type: 'todo',
          path: match[1],
          line: parseInt(match[2], 10),
          detail: match[3].trim(),
        });
      }
    }
  } catch { /* grep may return non-zero if no matches */ }
  return items;
}

/**
 * Find large files (>threshold lines).
 */
export function findLargeFiles(threshold = 400): CruftItem[] {
  const items: CruftItem[] = [];
  try {
    const wcOutput = execSync(
      `find crux/ apps/web/src/ \\( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' \\) ! -name '*.test.*' ! -name '*.d.ts' | xargs wc -l 2>/dev/null | sort -rn | head -30`,
      EXEC_OPTS
    );
    for (const line of wcOutput.split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match && match[2] !== 'total') {
        const lineCount = parseInt(match[1], 10);
        if (lineCount > threshold) {
          items.push({
            type: 'large-file',
            path: match[2],
            detail: `${lineCount} lines`,
          });
        }
      }
    }
  } catch { /* may fail */ }
  return items;
}

/**
 * Find commented-out code blocks (3+ consecutive comment lines with code syntax).
 */
export function findCommentedCode(): CruftItem[] {
  const items: CruftItem[] = [];
  try {
    const commentOutput = execSync(
      `grep -rn '^\\s*//.*[;{}()\\[\\]]' crux/ apps/web/src/ --include='*.ts' --include='*.tsx' 2>/dev/null | head -100 || true`,
      EXEC_OPTS
    );
    const byFile: Record<string, number[]> = {};
    for (const line of commentOutput.split('\n').filter(Boolean)) {
      const match = line.match(/^([^:]+):(\d+):/);
      if (match) {
        if (match[1].includes('.test.')) continue;
        const file = match[1];
        const lineNum = parseInt(match[2], 10);
        if (!byFile[file]) byFile[file] = [];
        byFile[file].push(lineNum);
      }
    }
    for (const [file, lines] of Object.entries(byFile)) {
      lines.sort((a, b) => a - b);
      let runStart = lines[0];
      let runLen = 1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === lines[i - 1] + 1) {
          runLen++;
        } else {
          if (runLen >= 3) {
            items.push({ type: 'commented-code', path: file, line: runStart, detail: `${runLen} consecutive commented-out code lines` });
          }
          runStart = lines[i];
          runLen = 1;
        }
      }
      if (runLen >= 3) {
        items.push({ type: 'commented-code', path: file, line: runStart, detail: `${runLen} consecutive commented-out code lines` });
      }
    }
  } catch { /* may fail */ }
  return items;
}

/**
 * Run all cruft detectors and return combined results.
 */
export function detectAllCruft(largeFileThreshold = 400): CruftItem[] {
  return [
    ...findTodoComments(),
    ...findLargeFiles(largeFileThreshold),
    ...findCommentedCode(),
  ];
}
