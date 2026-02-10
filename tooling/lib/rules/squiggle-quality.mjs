/**
 * Rule: Squiggle Model Quality
 *
 * Validates Squiggle code inside <SquiggleEstimate> components:
 * 1. Detects point values used directly in mixture() calls — should use distributions
 * 2. Checks that SquiggleEstimate has a title prop
 */

import { createRule, Issue, Severity } from '../validation-engine.js';

/**
 * Extract all SquiggleEstimate code blocks from MDX content.
 * Returns array of { code, startLine } objects.
 */
function extractSquiggleBlocks(raw) {
  const blocks = [];
  // Match <SquiggleEstimate ... code={`...`} ... />
  const pattern = /<SquiggleEstimate\b([^>]*?)code=\{`([\s\S]*?)`\}([^>]*?)\/>/g;
  let match;
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
 * Detect point values (bare numbers) used as mixture arguments.
 *
 * Bad:  mixture(500e9, 350e9, 150e9, [0.3, 0.5, 0.2])
 * Good: mixture(400e9 to 650e9, 250e9 to 450e9, [0.3, 0.5, 0.2])
 *
 * Strategy: find mixture(...) calls, split args before the weight array,
 * and check if any arg is a bare numeric literal (no "to", no function call).
 */
function findPointMixtureArgs(code) {
  const issues = [];
  // Match mixture( ... ) — greedy but balanced enough for typical Squiggle code
  const mixturePattern = /mixture\s*\(([\s\S]*?)\)/g;
  let match;
  while ((match = mixturePattern.exec(code)) !== null) {
    const inner = match[1].trim();

    // Split on the weight array: everything before the last [...] are distribution args
    const weightArrayIdx = inner.lastIndexOf('[');
    const distPart = weightArrayIdx >= 0 ? inner.slice(0, weightArrayIdx) : inner;

    // Split distribution arguments by comma (simple heuristic)
    const args = distPart.split(',').map(a => a.trim()).filter(Boolean);

    for (const arg of args) {
      // A bare numeric literal: digits, dots, e-notation, optional sign, optional spaces
      // But NOT if it contains "to" (range) or "(" (function call like normal/beta)
      if (/^[\d.eE+\-\s]+$/.test(arg) && !arg.includes('to') && !arg.includes('(')) {
        issues.push(arg);
      }
    }
  }
  return issues;
}

export const squiggleQualityRule = createRule({
  id: 'squiggle-quality',
  name: 'Squiggle Model Quality',
  description: 'Validate Squiggle model code quality (distributions, titles)',

  check(content, engine) {
    const issues = [];

    // Only check files that use SquiggleEstimate
    if (!content.raw.includes('SquiggleEstimate')) {
      return issues;
    }

    const blocks = extractSquiggleBlocks(content.raw);

    for (const block of blocks) {
      // Check 1: Missing title
      const allProps = block.propsBefore + block.propsAfter;
      if (!allProps.includes('title=')) {
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
