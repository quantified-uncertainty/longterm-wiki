/**
 * Rule: Dollar Sign Validation
 *
 * Checks for dollar sign issues in MDX content:
 * 1. Unescaped $ before numbers - gets parsed as LaTeX math by KaTeX
 * 2. Double-escaped \\$ in body - renders as \$ with visible backslash
 *
 * Note: \\$ is valid in YAML frontmatter but not in MDX body content.
 */

import { createRule, Issue, Severity, FixType } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';
import { matchLinesOutsideCode, isInMermaid, isInJsxAttribute } from '../mdx-utils.ts';
import { UNESCAPED_DOLLAR_RE, DOUBLE_ESCAPED_DOLLAR_RE } from '../patterns.ts';

/** Skip positions inside Mermaid charts and JSX attributes where \\$ is valid */
const skipJsxAndMermaid = (body: string, pos: number) =>
  isInMermaid(body, pos) || isInJsxAttribute(body, pos);

export const dollarSignsRule = createRule({
  id: 'dollar-signs',
  name: 'Dollar Sign Escaping',
  description: 'Validate currency values are properly escaped for LaTeX',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Check for unescaped $ before numbers (skip Mermaid/JSX where escaping differs)
    matchLinesOutsideCode(content.body, UNESCAPED_DOLLAR_RE, ({ match, line, lineNum }: { match: RegExpExecArray; line: string; lineNum: number }) => {
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
    }, { skip: skipJsxAndMermaid });

    // Check for double-escaped \\$ (over-escaping) — but \\$ is valid inside
    // Mermaid chart template literals and JSX attributes, so skip those.
    matchLinesOutsideCode(content.body, DOUBLE_ESCAPED_DOLLAR_RE, ({ match, line, lineNum }: { match: RegExpExecArray; line: string; lineNum: number }) => {
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
    }, { skip: skipJsxAndMermaid });

    return issues;
  },
});

export default dollarSignsRule;
