/**
 * Rule: Tilde-Dollar Validation
 *
 * Checks for tilde (~) characters adjacent to escaped dollar signs (\$) in MDX content.
 *
 * The issue: In LaTeX context, ~ is a non-breaking space. When combined with \$ (escaped dollar),
 * the rendering can be incorrect:
 * - `~\$29M` might render as `-$29M` (tilde becomes hyphen)
 * - `~86%` followed by `(~\$29M)` can render as `86%-($29M)`
 *
 * The fix: Use the Unicode approximately symbol ≈ instead of tilde for approximations.
 * - `≈\$29M` renders correctly as `≈$29M`
 * - `≈86%` renders correctly as `≈86%`
 */

import { createRule, Issue, Severity, FixType } from '../validation-engine.js';
import type { ContentFile, ValidationEngine } from '../validation-engine.js';
import { matchLinesOutsideCode } from '../mdx-utils.mjs';

// Pattern: tilde followed by escaped dollar sign (problematic LaTeX interaction)
const TILDE_DOLLAR_PATTERN = /~\\\$/g;

// Pattern: tilde followed by number in table cells (may also render incorrectly)
// Matches: | ~86% | or | ~1986 | etc.
const TILDE_NUMBER_IN_TABLE_PATTERN = /\|[^|]*~\d+[^|]*\|/g;

export const tildeDollarRule = createRule({
  id: 'tilde-dollar',
  name: 'Tilde-Dollar Escaping',
  description: 'Detect tilde characters that render incorrectly with escaped dollar signs',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Check for ~\$ pattern (tilde + escaped dollar)
    matchLinesOutsideCode(content.body, TILDE_DOLLAR_PATTERN, ({ match, line, lineNum }: { match: RegExpExecArray; line: string; lineNum: number }) => {
      const context = line.slice(Math.max(0, match.index - 15), match.index + 20);
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: lineNum,
        message: `Tilde before escaped dollar sign: "~\\$" renders incorrectly in LaTeX. Use "≈\\$" instead (context: ...${context}...)`,
        severity: Severity.ERROR,
        fix: {
          type: FixType.REPLACE_TEXT,
          oldText: '~\\$',
          newText: '≈\\$',
        },
      }));
    });

    // Check for tilde before numbers in table cells
    matchLinesOutsideCode(content.body, TILDE_NUMBER_IN_TABLE_PATTERN, ({ match, line, lineNum }: { match: RegExpExecArray; line: string; lineNum: number }) => {
      // Only flag if the cell contains a tilde that's not the approximately symbol
      if (!match[0].includes('≈')) {
        const tildeMatch: RegExpMatchArray | null = match[0].match(/~(\d+)/);
        if (tildeMatch) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `Tilde in table cell: "${tildeMatch[0]}" may render incorrectly. Use "≈" instead of "~" (context: ${match[0].trim()})`,
            severity: Severity.WARNING,
            fix: {
              type: FixType.REPLACE_TEXT,
              oldText: tildeMatch[0],
              newText: `≈${tildeMatch[1]}`,
            },
          }));
        }
      }
    });

    return issues;
  },
});

export default tildeDollarRule;
