/**
 * Rule: Dollar Sign Validation
 *
 * Checks for dollar sign issues in MDX content and frontmatter:
 * 1. Unescaped $ before numbers in body — gets parsed as LaTeX math by KaTeX
 * 2. Double-escaped \\$ in body — renders as \$ with visible backslash
 * 3. Unescaped $ before numbers in frontmatter description/llmSummary fields —
 *    these fields are rendered in meta tags, JSON-LD, and page previews
 *
 * Frontmatter escaping conventions:
 * - Unquoted YAML:       $100 -> \$100   (backslash is literal in unquoted strings)
 * - Double-quoted YAML:  $100 -> \\$100  (\\=literal backslash via YAML escape)
 * - Single-quoted YAML:  not fixable (single-quoted strings have no escape mechanism)
 */

import { createRule, Issue, Severity, FixType } from '../validation/validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation/validation-engine.ts';
import { matchLinesOutsideCode, isInMermaid, isInJsxAttribute } from '../mdx-utils.ts';
import { UNESCAPED_DOLLAR_RE, DOUBLE_ESCAPED_DOLLAR_RE } from '../patterns.ts';

/** Skip positions inside Mermaid charts and JSX attributes where \\$ is valid */
const skipJsxAndMermaid = (body: string, pos: number) =>
  isInMermaid(body, pos) || isInJsxAttribute(body, pos);

/** Frontmatter fields that contain prose and should be checked for dollar sign escaping */
const FRONTMATTER_PROSE_FIELDS = ['description', 'llmSummary'] as const;

/**
 * Get the frontmatter end line using the same convention as
 * ValidationEngine._getFrontmatterEndLine() — returns (closing --- 0-indexed line + 1).
 */
function getEngineFrontmatterEndLine(raw: string): number {
  const lines = raw.split('\n');
  if (lines[0] !== '---') return 0;
  let dashCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '---') {
      dashCount++;
      if (dashCount === 2) return i + 1;
    }
  }
  return 0;
}

/**
 * Convert an unquoted YAML field value to a double-quoted YAML string.
 * Escapes internal double quotes and backslashes for YAML double-quote context.
 */
function toDoubleQuotedYaml(fieldName: string, unquotedValue: string): string {
  const escaped = unquotedValue
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `${fieldName}: "${escaped}"`;
}

/**
 * Check a single frontmatter field line for dollar sign issues.
 *
 * Two problems are detected:
 * 1. Unescaped $<digit> in any quoting style
 * 2. \$ in unquoted YAML -- valid YAML but breaks MDX compilation because
 *    remark-mdx-frontmatter converts values to JS string literals where
 *    \$ is an invalid escape sequence
 *
 * All fixes output double-quoted YAML with \\$ for MDX safety.
 * Uses REPLACE_LINE to fix all occurrences on the line at once.
 */
function checkFrontmatterField(
  ruleId: string,
  content: ContentFile,
  fieldName: string,
  rawLine: string,
  rawLineNum1: number,
  fmEndLine: number,
): Issue[] {
  const issues: Issue[] = [];
  const fieldValue = (content.frontmatter as Record<string, unknown>)[fieldName];
  if (typeof fieldValue !== 'string') return issues;

  // Detect quoting style
  const afterKey = rawLine.replace(new RegExp(`^${fieldName}:\\s*`), '');
  const isDoubleQuoted = afterKey.startsWith('"');
  const isSingleQuoted = afterKey.startsWith("'");

  // Single-quoted YAML has no escape mechanism -- skip
  if (isSingleQuoted) return issues;

  // Body-relative line for the fix system:
  //   engine computes: absLine = issue.line + fmEndLine
  //   We need absLine = rawLineNum1, so issue.line = rawLineNum1 - fmEndLine
  const bodyRelativeLine = rawLineNum1 - fmEndLine;

  // --- Check 1: \$ in unquoted YAML (breaks MDX compilation) ---
  // In unquoted YAML, \$ is literal backslash+dollar. But remark-mdx-frontmatter
  // converts this to a JS string literal where \$ is an invalid escape sequence.
  // Fix: convert to double-quoted YAML where \\ represents literal backslash.
  if (!isDoubleQuoted && /\\\$/.test(rawLine)) {
    const unquotedValue = afterKey;
    const fixedLine = toDoubleQuotedYaml(fieldName, unquotedValue);
    const bsIndex = rawLine.indexOf('\\$');
    const context = rawLine.slice(Math.max(0, bsIndex - 10), bsIndex + 15);

    issues.push(new Issue({
      rule: ruleId,
      file: content.path,
      line: bodyRelativeLine,
      message: `Backslash-dollar in unquoted YAML frontmatter ${fieldName} breaks MDX compilation. Must use double-quoted YAML with \\\\$ (context: ...${context}...)`,
      severity: Severity.ERROR,
      fix: {
        type: FixType.REPLACE_LINE,
        content: fixedLine,
      },
    }));

    return issues;
  }

  // --- Check 2: Unescaped $<digit> ---
  const regex = isDoubleQuoted
    ? /(?<!\\\\)\$(\d)/g
    : /(?<!\\)\$(\d)/g;

  const matches: { match: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(rawLine)) !== null) {
    matches.push({ match: m[0], index: m.index });
  }
  if (matches.length === 0) return issues;

  // Build fixed line -- always target double-quoted YAML for MDX safety.
  let fixedLine: string;
  if (isDoubleQuoted) {
    // Already double-quoted: add \\ before each unescaped $
    const fixRegex = /(?<!\\\\)\$(\d)/g;
    fixedLine = rawLine.replace(fixRegex, '\\\\$$$1');
  } else {
    // Unquoted: escape $ signs then convert to double-quoted YAML
    const valueWithEscapedDollars = afterKey.replace(/(?<!\\)\$(?=\d)/g, '\\$');
    fixedLine = toDoubleQuotedYaml(fieldName, valueWithEscapedDollars);
  }

  for (let i = 0; i < matches.length; i++) {
    const { match, index } = matches[i];
    const context = rawLine.slice(Math.max(0, index - 10), index + 15);

    issues.push(new Issue({
      rule: ruleId,
      file: content.path,
      line: bodyRelativeLine,
      message: `Unescaped dollar sign in frontmatter ${fieldName}: "${match}" should be escaped (context: ...${context}...)`,
      severity: Severity.ERROR,
      fix: i === 0 ? {
        type: FixType.REPLACE_LINE,
        content: fixedLine,
      } : null,
    }));
  }

  return issues;
}

export const dollarSignsRule = createRule({
  id: 'dollar-signs',
  name: 'Dollar Sign Escaping',
  description: 'Validate currency values are properly escaped for LaTeX (body and frontmatter)',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // --- Body checks ---

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

    // --- Frontmatter checks ---

    const fmEndLine = getEngineFrontmatterEndLine(content.raw);
    if (fmEndLine > 0) {
      const rawLines = content.raw.split('\n');
      for (let i = 0; i < fmEndLine; i++) {
        const line = rawLines[i];
        for (const field of FRONTMATTER_PROSE_FIELDS) {
          if (line.startsWith(`${field}:`)) {
            const fieldIssues = checkFrontmatterField(
              this.id, content, field, line,
              i + 1,
              fmEndLine,
            );
            issues.push(...fieldIssues);
          }
        }
      }
    }

    return issues;
  },
});

export default dollarSignsRule;
