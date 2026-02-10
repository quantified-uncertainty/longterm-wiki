/**
 * Vague Citation Validation Rule
 *
 * Detects vague source citations in tables that lack specificity.
 * Examples of violations:
 *   - "Interview" (should be "Joe Rogan Experience #123 (March 2020)")
 *   - "Earnings call" (should be "Tesla Q4 2021 earnings call")
 *   - "Conference talk" (should be "MIT Aeronautics Centennial Symposium (Oct 2014)")
 *   - "Reports" (should be specific report name with date)
 *   - "Various interviews" (should list specific interviews)
 *
 * This helps ensure track record pages and similar content have verifiable citations.
 */

import { Severity, Issue } from '../validation-engine.js';

// Patterns that indicate a vague citation when standing alone in a table cell
// These are fine in prose but problematic as sole source references
const VAGUE_PATTERNS = [
  // Interviews without specifics
  /^\s*Interview\s*$/i,
  /^\s*Interviews\s*$/i,
  /^\s*Various interviews?\s*$/i,
  /^\s*Multiple interviews?\s*$/i,

  // Calls/meetings without specifics
  /^\s*Earnings call\s*$/i,
  /^\s*Earnings calls?\s*$/i,
  /^\s*Conference call\s*$/i,
  /^\s*Shareholder call\s*$/i,
  /^\s*Investor call\s*$/i,

  // Events without specifics
  /^\s*Conference\s*$/i,
  /^\s*Conference talk\s*$/i,
  /^\s*Talk\s*$/i,
  /^\s*Presentation\s*$/i,
  /^\s*Demo\s*$/i,
  /^\s*Event\s*$/i,
  /^\s*Summit\s*$/i,

  // Reports without specifics
  /^\s*Report\s*$/i,
  /^\s*Reports\s*$/i,
  /^\s*Various reports?\s*$/i,

  // Sources without specifics
  /^\s*Various\s*$/i,
  /^\s*Various sources?\s*$/i,
  /^\s*Multiple sources?\s*$/i,

  // Social media without specifics
  /^\s*Twitter\s*$/i,
  /^\s*Tweet\s*$/i,
  /^\s*X post\s*$/i,
  /^\s*Social media\s*$/i,

  // News without specifics
  /^\s*News\s*$/i,
  /^\s*News article\s*$/i,
  /^\s*Article\s*$/i,
  /^\s*Blog post\s*$/i,
];

// Table cell pattern - captures content between | delimiters
// Matches the last cell in a table row (typically the "Source" column)
const TABLE_CELL_PATTERN = /\|\s*([^|]+?)\s*\|?\s*$/gm;

// Full table row pattern to identify source columns
const TABLE_ROW_PATTERN = /^\|(.+)\|$/gm;

export const vagueCitationsRule = {
  id: 'vague-citations',
  name: 'Vague Citations',
  description: 'Detect vague source citations that lack specificity',
  severity: Severity.WARNING,

  check(contentFile, engine) {
    const issues = [];
    const content = contentFile.body || '';
    if (!content) return issues;

    const lines = content.split('\n');

    // Track if we're in a table with a "Source" column
    let inTable = false;
    let sourceColumnIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check if this is a table header row
      if (line.includes('|') && line.toLowerCase().includes('source')) {
        inTable = true;
        // Find which column is "Source"
        const cells = line.split('|').map(c => c.trim()).filter(c => c);
        sourceColumnIndex = cells.findIndex(c =>
          c.toLowerCase() === 'source' ||
          c.toLowerCase() === 'sources' ||
          c.toLowerCase() === 'reference' ||
          c.toLowerCase() === 'references'
        );
        continue;
      }

      // Check if we've left the table
      if (inTable && !line.includes('|')) {
        inTable = false;
        sourceColumnIndex = -1;
        continue;
      }

      // Skip separator rows (|---|---|)
      if (line.match(/^\|[\s-:|]+\|$/)) {
        continue;
      }

      // If we're in a table with a source column, check that column
      if (inTable && sourceColumnIndex >= 0 && line.includes('|')) {
        const cells = line.split('|').map(c => c.trim()).filter(c => c);
        const sourceCell = cells[sourceColumnIndex];

        if (sourceCell) {
          // Check if the source cell matches any vague pattern
          for (const pattern of VAGUE_PATTERNS) {
            if (pattern.test(sourceCell)) {
              issues.push(new Issue({
                rule: 'vague-citations',
                file: contentFile.path,
                line: lineNum,
                message: `Vague citation "${sourceCell}" - specify the exact source (e.g., interview name, date, publication)`,
                severity: Severity.WARNING,
                context: line.trim(),
              }));
              break; // Only report once per cell
            }
          }
        }
      }
    }

    return issues;
  },
};
