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

import { createRule, Issue, Severity, FixType } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';
import { matchLinesOutsideCode, isInJsxAttribute } from '../mdx-utils.ts';
import { LESS_THAN_BEFORE_NUM_RE } from '../patterns.ts';

/**
 * Check if the < is already escaped
 */
function isAlreadyEscaped(content: string, position: number): boolean {
  const after = content.slice(position, position + 4);
  if (after === '&lt;') return true;
  if (position > 0 && content[position - 1] === '\\') return true;
  return false;
}

/**
 * Check if this looks like a valid HTML/JSX tag
 */
function isValidHtmlTag(content: string, position: number): boolean {
  const after = content.slice(position, position + 20);
  return /^<[a-zA-Z\/]/.test(after);
}

export const comparisonOperatorsRule = createRule({
  id: 'comparison-operators',
  name: 'Comparison Operator Escaping',
  description: 'Less-than before numbers must be escaped as &lt; to prevent JSX parsing',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    matchLinesOutsideCode(content.body, LESS_THAN_BEFORE_NUM_RE, ({ match, line, lineNum, absolutePos }: { match: RegExpExecArray; line: string; lineNum: number; absolutePos: number }) => {
      // Skip if in safe context
      if (isInJsxAttribute(content.body, absolutePos)) return;
      if (isAlreadyEscaped(content.body, absolutePos)) return;
      if (isValidHtmlTag(content.body, absolutePos)) return;

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
    });

    return issues;
  },
});

export default comparisonOperatorsRule;
