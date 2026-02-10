/**
 * Rule: Comparison Operator Escaping
 *
 * Less-than (<) followed by numbers/letters gets parsed as JSX tags in MDX,
 * causing build failures. These need to be escaped as &lt;
 *
 * Examples that cause issues:
 *   <10% response time     -> parsed as <10 JSX tag
 *   <$100 budget           -> parsed as JSX
 *   <1 year timeframe      -> parsed as JSX
 */

import { createRule, Issue, Severity, FixType } from '../validation-engine.js';
import { isInCodeBlock, isInJsxAttribute, getFrontmatterEndLine } from '../mdx-utils.mjs';

// Pattern: < followed by a digit or \$ (escaped dollar sign)
const LESS_THAN_PATTERN = /<(\d|\\?\$)/g;

/**
 * Check if the < is already escaped
 */
function isAlreadyEscaped(content, position) {
  const after = content.slice(position, position + 4);
  if (after === '&lt;') return true;
  if (position > 0 && content[position - 1] === '\\') return true;
  return false;
}

/**
 * Check if this looks like a valid HTML/JSX tag
 */
function isValidHtmlTag(content, position) {
  const after = content.slice(position, position + 20);
  return /^<[a-zA-Z\/]/.test(after);
}

export const comparisonOperatorsRule = createRule({
  id: 'comparison-operators',
  name: 'Comparison Operator Escaping',
  description: 'Less-than before numbers must be escaped as &lt; to prevent JSX parsing',

  check(content, engine) {
    const issues = [];
    const lines = content.body.split('\n');
    let position = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Find less-than matches
      let match;
      const ltRegex = new RegExp(LESS_THAN_PATTERN.source, 'g');

      while ((match = ltRegex.exec(line)) !== null) {
        const absolutePos = position + match.index;

        // Skip if in safe context
        if (isInCodeBlock(content.body, absolutePos)) continue;
        if (isInJsxAttribute(content.body, absolutePos)) continue;
        if (isAlreadyEscaped(content.body, absolutePos)) continue;
        if (isValidHtmlTag(content.body, absolutePos)) continue;

        const context = line.slice(Math.max(0, match.index - 10), match.index + 15);
        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          line: lineNum,
          message: `Unescaped "<" before number: "${match[0]}" should be "&lt;${match[1]}" (context: ...${context}...)`,
          severity: Severity.ERROR,
          fix: {
            type: FixType.REPLACE_TEXT,
            oldText: match[0],
            newText: `&lt;${match[1]}`,
          },
        }));
      }

      position += line.length + 1;
    }

    return issues;
  },
});

export default comparisonOperatorsRule;
