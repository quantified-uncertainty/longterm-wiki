/**
 * Rule: Placeholder and Incomplete Content Detection
 *
 * Detects common patterns of unfinished content:
 * - TODO/TBD/FIXME markers
 * - Placeholder patterns like [Value], [Description], etc.
 * - Incomplete sentences (trailing ...)
 * - Lorem ipsum text
 */

import { createRule, Issue, Severity } from '../validation-engine.js';
import { isInCodeBlock, isInMermaid, isInComment, getLineNumber, shouldSkipValidation } from '../mdx-utils.mjs';

// Placeholder patterns to detect
const PLACEHOLDER_PATTERNS = [
  // Explicit markers
  { pattern: /\bTODO\b/gi, name: 'TODO marker', severity: Severity.WARNING },
  { pattern: /\bTBD\b/gi, name: 'TBD marker', severity: Severity.WARNING },
  { pattern: /\bFIXME\b/gi, name: 'FIXME marker', severity: Severity.WARNING },
  { pattern: /\bXXX\b/g, name: 'XXX marker', severity: Severity.WARNING },

  // Bracketed placeholders
  { pattern: /\[(?:Value|TBD|TODO|TBC|N\/A|XX+|\.\.\.)\]/gi, name: 'Bracketed placeholder', severity: Severity.WARNING },
  { pattern: /\[(?:Description|Explanation|Details|Content|Text)\]/gi, name: 'Description placeholder', severity: Severity.WARNING },
  { pattern: /\[(?:Insert|Add|Fill in|Complete|Provide)\s+[^\]]*\]/gi, name: 'Action placeholder', severity: Severity.WARNING },
  { pattern: /\[(?:Source|Citation|Reference|Link)\](?!\()/gi, name: 'Citation placeholder', severity: Severity.WARNING },
  { pattern: /\[(?:Date|Year|Number|Percentage|Figure)\]/gi, name: 'Data placeholder', severity: Severity.WARNING },

  // Numbered placeholders (from templates)
  { pattern: /\[(?:Limitation|Uncertainty|Point|Item|Example)\s*\d*\](?::\s*\[|\s*-\s*\[)/gi, name: 'Template list placeholder', severity: Severity.WARNING },

  // Lorem ipsum
  { pattern: /Lorem ipsum/gi, name: 'Lorem ipsum text', severity: Severity.ERROR },

  // Template prompts
  { pattern: /\[Your [^\]]+\]/gi, name: 'Template prompt placeholder', severity: Severity.WARNING },

  // Ellipsis patterns
  { pattern: /^\s*\*\s*\.\.\.\s*$/gm, name: 'Bullet with only ellipsis', severity: Severity.WARNING },
  { pattern: /^\s*-\s*\.\.\.\s*$/gm, name: 'List item with only ellipsis', severity: Severity.WARNING },
];

export const placeholdersRule = createRule({
  id: 'placeholders',
  name: 'Placeholder Detection',
  description: 'Detect TODO markers, placeholder text, and incomplete content',

  check(content, engine) {
    const issues = [];
    const body = content.body;

    // Skip validation for stubs, documentation, and internal pages
    if (shouldSkipValidation(content.frontmatter) ||
        content.relativePath.includes('/internal/')) {
      return issues;
    }

    // Check each placeholder pattern
    for (const { pattern, name, severity } of PLACEHOLDER_PATTERNS) {
      pattern.lastIndex = 0;
      let match;

      while ((match = pattern.exec(body)) !== null) {
        const position = match.index;

        // Skip if in code block, comment, or Mermaid diagram
        if (isInCodeBlock(body, position) ||
            isInComment(body, position) ||
            isInMermaid(body, position)) {
          continue;
        }

        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          line: getLineNumber(body, position),
          message: `${name}: "${match[0]}"`,
          severity,
        }));
      }
    }

    return issues;
  },
});

export default placeholdersRule;
