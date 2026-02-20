/**
 * Rule: No Quoted Subcategory Values
 *
 * Subcategory frontmatter values should not be quoted. YAML scalar strings
 * for simple identifiers (like subcategory slugs) don't need quotes, and
 * quoted variants cause inconsistent sidebar grouping when they coexist
 * with unquoted variants of the same value. Starlight reads the raw
 * frontmatter string value, so `subcategory: "labs"` and `subcategory: labs`
 * are treated as different keys and produce separate sidebar sections.
 *
 * Bad:  subcategory: "labs"
 * Good: subcategory: labs
 *
 * This was found manually in an audit (PR #350) affecting 9 pages.
 * See: https://github.com/quantified-uncertainty/longterm-wiki/issues/351
 */

import { createRule, Issue, Severity } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';

// Matches quoted subcategory values in YAML frontmatter
// e.g. subcategory: "labs" or subcategory: 'labs'
const QUOTED_SUBCATEGORY_RE = /^subcategory:\s*(["'])([^"'\n]+?)\1\s*$/m;

export const noQuotedSubcategoryRule = createRule({
  id: 'no-quoted-subcategory',
  name: 'No Quoted Subcategory Values',
  description: 'Subcategory values should not be quoted (use `subcategory: labs` not `subcategory: "labs"`)',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Extract frontmatter section (between the first pair of --- markers)
    const raw = content.raw;
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return issues;

    const frontmatterText = fmMatch[1];
    const quotedMatch = QUOTED_SUBCATEGORY_RE.exec(frontmatterText);
    if (!quotedMatch) return issues;

    const quoteChar = quotedMatch[1]; // " or '
    const unquotedValue = quotedMatch[2]; // the actual value without quotes
    const matchedText = quotedMatch[0]; // full matched line e.g. "subcategory: \"labs\""

    // Find line number in full file (1-indexed)
    const matchIndex = raw.indexOf(matchedText);
    const lineNum = raw.slice(0, matchIndex).split('\n').length;

    issues.push(new Issue({
      rule: this.id,
      file: content.path,
      line: lineNum,
      message: `Quoted subcategory value — use \`subcategory: ${unquotedValue}\` not \`subcategory: ${quoteChar}${unquotedValue}${quoteChar}\``,
      severity: Severity.ERROR,
    }));

    return issues;
  },
});

export default noQuotedSubcategoryRule;
