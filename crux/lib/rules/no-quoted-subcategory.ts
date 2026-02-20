/**
 * Rule: No Quoted Subcategory Values
 *
 * Subcategory frontmatter values should not be quoted. Simple YAML string
 * scalars (like subcategory slugs) don't need quotes — both `subcategory: labs`
 * and `subcategory: "labs"` produce the identical parsed value `labs`. Quoting
 * unnecessarily causes style inconsistency across the codebase, and mixed
 * quoted/unquoted values have caused sidebar grouping bugs in the past due to
 * caching or build-pipeline issues where the raw frontmatter text was used
 * rather than the parsed value.
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

    // Compute absolute position of the match using quotedMatch.index (relative to
    // frontmatterText) plus the offset of frontmatterText within raw. Using the
    // regex index avoids the raw.indexOf() pitfall where an identical string
    // earlier in the file would produce a wrong line number.
    const headerLen = raw.startsWith('---\r\n') ? 5 : 4; // "---\r\n" or "---\n"
    const frontmatterStart = (fmMatch.index ?? 0) + headerLen;
    const matchAbsoluteIndex = frontmatterStart + quotedMatch.index;
    const lineNum = raw.slice(0, matchAbsoluteIndex).split('\n').length;

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
