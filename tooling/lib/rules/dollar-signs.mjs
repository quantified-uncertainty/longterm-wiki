/**
 * Rule: Dollar Sign Validation
 *
 * Checks for dollar sign issues in MDX content:
 * 1. Unescaped $ before numbers - gets parsed as LaTeX math by KaTeX
 * 2. Double-escaped \\$ in body - renders as \$ with visible backslash
 *
 * Note: \\$ is valid in YAML frontmatter but not in MDX body content.
 */

import { createRule, Issue, Severity, FixType } from '../validation-engine.mjs';
import { isInCodeBlock } from '../mdx-utils.mjs';

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
    const lines = content.body.split('\n');
    let position = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check for unescaped $ before numbers
      let match;
      const unescapedRegex = new RegExp(UNESCAPED_DOLLAR_PATTERN.source, 'g');
      while ((match = unescapedRegex.exec(line)) !== null) {
        const absolutePos = position + match.index;

        if (!isInCodeBlock(content.body, absolutePos)) {
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
        }
      }

      // Check for double-escaped \\$ (over-escaping)
      const doubleEscapedRegex = new RegExp(DOUBLE_ESCAPED_PATTERN.source, 'g');
      while ((match = doubleEscapedRegex.exec(line)) !== null) {
        const absolutePos = position + match.index;

        if (!isInCodeBlock(content.body, absolutePos)) {
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
        }
      }

      position += line.length + 1;
    }

    return issues;
  },
});

export default dollarSignsRule;
