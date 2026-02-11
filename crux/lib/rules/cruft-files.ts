/**
 * Rule: Cruft Files Detection
 *
 * Detects files that shouldn't be in the public content directory:
 * - Underscore-prefixed files (except __index__)
 * - TODO/ENHANCEMENT files
 * - Backup files (.bak, .old, ~)
 * - Empty or near-empty files
 */

import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { basename } from 'path';

// Patterns that indicate cruft files
// Note: Some patterns have path conditions to avoid false positives
const CRUFT_PATTERNS: { pattern: RegExp; message: string }[] = [
  { pattern: /^_[^_]/, message: 'Underscore-prefixed file (internal/hidden convention)' },
  { pattern: /^TODO\./i, message: 'TODO file exposed in public content' },
  { pattern: /_TODO\./i, message: 'TODO file exposed in public content' },
  { pattern: /^ENHANCEMENT\./i, message: 'Enhancement tracking file exposed in public content' },
  { pattern: /_ENHANCEMENT\./i, message: 'Enhancement tracking file exposed in public content' },
  { pattern: /\.bak$/, message: 'Backup file in content directory' },
  { pattern: /\.old$/, message: 'Old version file in content directory' },
  { pattern: /~$/, message: 'Editor backup file in content directory' },
  { pattern: /^draft[-_]/i, message: 'Draft file that may not be ready for publication' },
  { pattern: /^temp[-_]/i, message: 'Temporary file in content directory' },
  { pattern: /^test[-_]/i, message: 'Test file in content directory' },
];

// Minimum content length to not be considered "empty"
const MIN_BODY_LENGTH = 50;

export const cruftFilesRule = createRule({
  id: 'cruft-files',
  name: 'Cruft Files Detection',
  description: 'Detect files that should not be in public content',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const fileName = basename(content.path);

    // Check filename patterns
    for (const { pattern, message } of CRUFT_PATTERNS) {
      if (pattern.test(fileName)) {
        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          message: message,
          severity: Severity.WARNING,
        }));
        break; // One filename issue is enough
      }
    }

    // Check for empty/near-empty files
    const bodyText = content.body.replace(/\s+/g, ' ').trim();
    if (bodyText.length < MIN_BODY_LENGTH) {
      // Check if it's truly empty vs just having frontmatter
      const hasSubstantiveContent = bodyText.length > 0 ||
        Object.keys(content.frontmatter).length > 3; // More than just title/description

      if (!hasSubstantiveContent) {
        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          message: `File has very little content (${bodyText.length} chars) - may be placeholder`,
          severity: Severity.INFO,
        }));
      }
    }

    return issues;
  },
});

export default cruftFilesRule;
