/**
 * Rule: Dollar Sign Validation
 *
 * Checks for dollar sign issues in MDX content:
 * 1. Unescaped $ before numbers - gets parsed as LaTeX math by KaTeX
 * 2. Double-escaped \\$ in body - renders as \$ with visible backslash
 *
 * Note: \\$ is valid in YAML frontmatter but not in MDX body content.
 */

import { createRule, Issue, Severity, FixType } from '../validation-engine.js';
import { matchLinesOutsideCode } from '../mdx-utils.mjs';

// Pattern: unescaped $ followed by a number (not already escaped with \)
const UNESCAPED_DOLLAR_PATTERN = /(?<!\\)\$(\d)/g;

// Pattern: double-escaped $ (\\$) in MDX body - over-escaping
const DOUBLE_ESCAPED_PATTERN = /\\\\\$/g;

export const dollarSignsRule = createRule({
  id: 'dollar-signs',
  name: 'Dollar Sign Escaping',
  description: 'Validate currency values are properly escaped for LaTeX',

  check(content, engine) {
    const issues = [];

    // Check for unescaped $ before numbers
    matchLinesOutsideCode(content.body, UNESCAPED_DOLLAR_PATTERN, ({ match, line, lineNum }) => {
      const context = line.slice(Math.max(0, match.index - 10), match.index + 15);
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: lineNum,
        message: `Unescaped dollar sign: "${match[0]}" should be "\\${match[0]}" (context: ...${context}...)`,
        severity: Severity.ERROR,
        fix: {
          type: FixType.REPLACE_TEXT,
          oldText: match[0],
          newText: `\\${match[0]}`,
        },
      }));
    });

    // Check for double-escaped \\$ (over-escaping)
    matchLinesOutsideCode(content.body, DOUBLE_ESCAPED_PATTERN, ({ match, line, lineNum }) => {
      const context = line.slice(Math.max(0, match.index - 10), match.index + 15);
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: lineNum,
        message: `Double-escaped dollar sign: "\\\\$" should be "\\$" (context: ...${context}...)`,
        severity: Severity.ERROR,
        fix: {
          type: FixType.REPLACE_TEXT,
          oldText: '\\\\$',
          newText: '\\$',
        },
      }));
    });

    return issues;
  },
});

export default dollarSignsRule;
