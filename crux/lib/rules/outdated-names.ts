/**
 * Rule: Outdated Organization Names
 *
 * Checks for outdated organization names that should be updated to current names.
 * This helps maintain consistency and accuracy across the wiki.
 *
 * Current mappings:
 * - "Open Philanthropy" → "Coefficient Giving" (rebranded November 2025)
 */

import { createRule, Issue, Severity, ContentFile, ValidationEngine } from '../validation-engine.js';
import { isInCodeBlock } from '../mdx-utils.ts';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface OutdatedNameConfig {
  pattern: RegExp;
  oldName: string;
  newName: string;
  note: string;
  allowedContexts: RegExp[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Outdated names and their replacements
// Add new entries as organizations rebrand
const OUTDATED_NAMES: OutdatedNameConfig[] = [
  {
    pattern: /\bOpen Philanthropy\b/g,
    oldName: 'Open Philanthropy',
    newName: 'Coefficient Giving',
    note: 'Rebranded November 2025',
    // Exceptions where the old name is acceptable (historical context, quotes, etc.)
    allowedContexts: [
      /formerly\s+Open Philanthropy/i,
      /\(formerly\s+Open Philanthropy\)/i,
      /Open Philanthropy Project/i, // Historical name from 2014-2019
      /rebranded.*Open Philanthropy/i,
      /Open Philanthropy.*rebrand/i,
      /was.*called.*Open Philanthropy/i,
      /previously.*Open Philanthropy/i,
      /known as.*Open Philanthropy/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Rule export
// ---------------------------------------------------------------------------

export const outdatedNamesRule = createRule({
  id: 'outdated-names',
  name: 'Outdated Organization Names',
  description: 'Check for outdated organization names that should be updated',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const lines = content.body.split('\n');
    let position = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      for (const nameConfig of OUTDATED_NAMES) {
        const regex = new RegExp(nameConfig.pattern.source, 'g');
        let match: RegExpExecArray | null;

        while ((match = regex.exec(line)) !== null) {
          const absolutePos = position + match.index;

          // Skip if in code block
          if (isInCodeBlock(content.body, absolutePos)) {
            continue;
          }

          // Check if this usage is in an allowed context (historical reference, etc.)
          const contextStart = Math.max(0, match.index - 50);
          const contextEnd = Math.min(line.length, match.index + match[0].length + 50);
          const context = line.slice(contextStart, contextEnd);

          const isAllowedContext = nameConfig.allowedContexts.some(
            (allowedPattern: RegExp) => allowedPattern.test(context)
          );

          if (isAllowedContext) {
            continue;
          }

          // Check if already has "(formerly X)" nearby
          const surroundingText = line.slice(
            Math.max(0, match.index - 30),
            Math.min(line.length, match.index + match[0].length + 30)
          );
          if (/formerly|previously|was called|rebranded/i.test(surroundingText)) {
            continue;
          }

          const displayContext = line.slice(
            Math.max(0, match.index - 20),
            Math.min(line.length, match.index + match[0].length + 20)
          );

          issues.push(
            new Issue({
              rule: this.id,
              file: content.path,
              line: lineNum,
              message: `Outdated name "${nameConfig.oldName}" should be "${nameConfig.newName}" (${nameConfig.note}). Context: ...${displayContext}...`,
              severity: Severity.WARNING,
              fix: {
                type: 'replace-text',
                oldText: match[0],
                newText: nameConfig.newName,
              },
            })
          );
        }
      }

      position += line.length + 1;
    }

    return issues;
  },
});

export default outdatedNamesRule;
