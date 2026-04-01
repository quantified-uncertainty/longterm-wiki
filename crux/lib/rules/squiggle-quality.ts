/**
 * Rule: Squiggle Model Quality
 *
 * Validates Squiggle code inside <SquiggleEstimate> components:
 * 1. Detects point values used directly in mixture() calls — should use distributions
 * 2. Checks that SquiggleEstimate has a title prop
 */

import { createRule, Issue, Severity, ContentFile, ValidationEngine } from '../validation/validation-engine.ts';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface SquiggleBlock {
  fullMatch: string;
  propsBefore: string;
  code: string;
  propsAfter: string;
  startLine: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract all SquiggleEstimate code blocks from MDX content.
 * Returns array of { code, startLine } objects.
 */
function extractSquiggleBlocks(raw: string): SquiggleBlock[] {
  const blocks: SquiggleBlock[] = [];
  // Match <SquiggleEstimate ... code={`...`} ... />
  const pattern = /<SquiggleEstimate\b([^>]*?)code=\{`([\s\S]*?)`\}([^>]*?)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const before = raw.slice(0, match.index);
    const startLine = before.split('\n').length;
    blocks.push({
      fullMatch: match[0],
      propsBefore: match[1],
      code: match[2],
      propsAfter: match[3],
      startLine,
    });
  }
  return blocks;
}

/**
 * Extract the balanced content of a mixture() call starting from `startIdx`
 * (pointing at the opening paren). Tracks paren depth to find the matching
 * closing `)`, which handles nested calls like `mixture(normal(500, 50), ...)`.
 */
function extractBalancedParens(code: string, startIdx: number): string | null {
  if (code[startIdx] !== '(') return null;
  let depth = 0;
  for (let i = startIdx; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') {
      depth--;
      if (depth === 0) {
        return code.slice(startIdx + 1, i);
      }
    }
  }
  return null; // unbalanced
}

/**
 * Split a string by top-level commas only — commas inside nested parens
 * or brackets are not split points.
 */
function splitTopLevelCommas(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;

    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * Detect point values (bare numbers) used as mixture arguments.
 *
 * Bad:  mixture(500e9, 350e9, 150e9, [0.3, 0.5, 0.2])
 * Good: mixture(400e9 to 650e9, 250e9 to 450e9, [0.3, 0.5, 0.2])
 *
 * Strategy: find mixture(...) calls using paren-depth tracking (handles
 * nested calls like `normal(500, 50)`), split args by top-level commas,
 * skip the weight array, and check remaining args for bare numeric literals.
 */
function findPointMixtureArgs(code: string): string[] {
  const issues: string[] = [];
  const mixtureCallPattern = /mixture\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = mixtureCallPattern.exec(code)) !== null) {
    // Find the opening paren position
    const parenIdx = code.indexOf('(', match.index);
    const inner = extractBalancedParens(code, parenIdx);
    if (!inner) continue;

    const args = splitTopLevelCommas(inner);

    // The weight array is the last argument if it starts with '['
    const distArgs = args.length > 0 && args[args.length - 1].startsWith('[')
      ? args.slice(0, -1)
      : args;

    for (const arg of distArgs) {
      // A bare numeric literal: digits, dots, e-notation, optional sign, optional spaces
      // But NOT if it contains "to" (range) or "(" (function call like normal/beta)
      if (/^[\d.eE+\-\s]+$/.test(arg) && !arg.includes('to') && !arg.includes('(')) {
        issues.push(arg);
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Rule export
// ---------------------------------------------------------------------------

export const squiggleQualityRule = createRule({
  id: 'squiggle-quality',
  name: 'Squiggle Model Quality',
  description: 'Validate Squiggle model code quality (distributions, titles)',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Only check files that use SquiggleEstimate
    if (!content.raw.includes('SquiggleEstimate')) {
      return issues;
    }

    const blocks = extractSquiggleBlocks(content.raw);

    for (const block of blocks) {
      // Check 1: Missing title
      const allProps = block.propsBefore + block.propsAfter;
      if (!/\btitle\s*=/.test(allProps)) {
        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          line: block.startLine,
          message: 'SquiggleEstimate missing title prop — add title="Descriptive Name"',
          severity: Severity.WARNING,
        }));
      }

      // Check 2: Point values in mixture()
      const pointArgs = findPointMixtureArgs(block.code);
      if (pointArgs.length > 0) {
        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          line: block.startLine,
          message: `mixture() uses point values (${pointArgs.join(', ')}). Use continuous distributions like "X to Y" instead for smoother output.`,
          severity: Severity.WARNING,
        }));
      }
    }

    return issues;
  },
});

export default squiggleQualityRule;
