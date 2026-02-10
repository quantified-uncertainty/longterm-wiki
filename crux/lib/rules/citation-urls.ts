/**
 * Citation URL Validation Rule
 *
 * Validates that footnote citations have valid URLs, not 'undefined' or empty.
 * Catches synthesis failures where URLs weren't properly extracted from research.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.js';

// Pattern: footnote definition with undefined or empty URL
// Matches: [^1]: [Title](undefined) or [^1]: [Title]()
const UNDEFINED_URL_PATTERN = /\[\^(\d+)\]:\s*\[([^\]]*)\]\((undefined|)\)/g;

// Pattern: footnote definition with placeholder URL
const PLACEHOLDER_URL_PATTERN = /\[\^(\d+)\]:\s*\[([^\]]*)\]\((https?:\/\/example\.com|https?:\/\/placeholder|TODO|TBD|#)\)/gi;

export const citationUrlsRule = {
  id: 'citation-urls',
  name: 'Citation URLs',
  description: 'Validate that footnote citations have valid URLs',
  severity: Severity.ERROR,

  check(contentFile: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');

    // Check each line for undefined/empty URLs
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check for undefined or empty URLs
      let match: RegExpExecArray | null;
      const undefinedRegex = new RegExp(UNDEFINED_URL_PATTERN.source, 'g');
      while ((match = undefinedRegex.exec(line)) !== null) {
        const footnoteNum = match[1];
        const linkText = match[2];
        const url = match[3] || '(empty)';

        issues.push(new Issue({
          rule: 'citation-urls',
          file: contentFile.path,
          line: lineNum,
          message: `Footnote [^${footnoteNum}] has invalid URL: "${url}". Citation "${linkText}" needs a valid URL.`,
          severity: Severity.ERROR,
        }));
      }

      // Check for placeholder URLs
      const placeholderRegex = new RegExp(PLACEHOLDER_URL_PATTERN.source, 'gi');
      while ((match = placeholderRegex.exec(line)) !== null) {
        const footnoteNum = match[1];
        const linkText = match[2];
        const url = match[3];

        issues.push(new Issue({
          rule: 'citation-urls',
          file: contentFile.path,
          line: lineNum,
          message: `Footnote [^${footnoteNum}] has placeholder URL: "${url}". Citation "${linkText}" needs a real URL.`,
          severity: Severity.WARNING,
        }));
      }
    }

    return issues;
  },
};
